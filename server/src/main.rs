mod admin;
mod auth;
mod config;
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
            }
        });
    }

    let app = Router::new()
        .route("/ws", get(ws::handler))
        .route("/health", get(|| async { "ok" }))
        .route("/metrics", get(|AxState(st): AxState<Arc<state::State>>| async move { st.metrics.render() }))
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
