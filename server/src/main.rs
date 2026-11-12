mod admin;
mod auth;
mod config;
mod files;
mod gifs;
mod livekit;
mod metrics;
mod persist;
mod state;
mod voice;
mod ws;

use anyhow::Result;
use axum::{extract::State as AxState, routing::get, Router};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cfg = config::Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(cfg.db_pool)
        .min_connections(cfg.db_pool.min(4))
        .connect(&cfg.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    tokio::fs::create_dir_all(&cfg.files_dir).await?;

    let (ptx, prx) = mpsc::channel(persist::QUEUE);
    let st = Arc::new(state::State::new(cfg.clone(), db, ptx));
    let persister = tokio::spawn(persist::run(st.clone(), prx));
    {
        let st = st.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                iv.tick().await;
                st.prune_nonces();
                gifs::prune(&st);
            }
        });
    }
    tokio::spawn(files::sweep(st.clone()));
    {
        let db = st.db.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                iv.tick().await;
                let result = sqlx::query(
                    "WITH removed AS ( \
                       DELETE FROM durable_events WHERE created_at < now() - interval '30 days' \
                       RETURNING channel_id, cursor \
                     ), pruned AS ( \
                       SELECT channel_id, MAX(cursor) AS cursor FROM removed GROUP BY channel_id \
                     ) \
                     INSERT INTO durable_event_state (channel_id, pruned_through) \
                     SELECT channel_id, cursor FROM pruned \
                     ON CONFLICT (channel_id) DO UPDATE \
                       SET pruned_through = GREATEST(durable_event_state.pruned_through, EXCLUDED.pruned_through)",
                )
                .execute(&db)
                .await;
                if let Err(error) = result {
                    tracing::warn!("durable event retention failed: {error}");
                }
            }
        });
    }

    let app = Router::new()
        .route("/ws", get(ws::handler))
        .route("/files", axum::routing::post(files::upload))
        .route("/files/{id}", get(files::download))
        .route("/health", get(|| async { "ok" }))
        .route("/metrics", get(|AxState(st): AxState<Arc<state::State>>| async move {
            format!("{}history_active {}\nupload_active {}\npersist_queue_depth {}\n",
                st.metrics.render(),
                128 - st.history_slots.available_permits(),
                8 - st.upload_slots.available_permits(),
                st.persist.max_capacity() - st.persist.capacity())
        }))
        .route("/metrics/reset", get(|AxState(st): AxState<Arc<state::State>>| async move { st.metrics.reset(); "reset" }))
        .with_state(st.clone());

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!("listening on {}", cfg.bind);
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;

    // Drain the persistence queue before exiting.
    let (done, wait) = oneshot::channel();
    if st.persist.send(persist::PersistOp::Flush(done)).await.is_ok() {
        let _ = wait.await;
    }
    persister.abort();
    tracing::warn!(
        messages_fanned_out = st.metrics.messages.load(std::sync::atomic::Ordering::Relaxed),
        persist_failures = st.metrics.persist_failures.load(std::sync::atomic::Ordering::Relaxed),
        "shutdown complete, persistence queue drained"
    );
    Ok(())
}
