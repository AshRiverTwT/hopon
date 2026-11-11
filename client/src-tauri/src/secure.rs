//! Refresh tokens at rest: DPAPI (current-user scope) on Windows, so the
//! cache file is useless if copied to another account or machine.

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn run(input: &[u8], protect: bool) -> Option<Vec<u8>> {
        unsafe {
            let inb = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            let ok = if protect {
                CryptProtectData(&inb, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
            } else {
                CryptUnprotectData(&inb, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut out)
            };
            if ok == 0 {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            Some(v)
        }
    }
    pub fn protect(b: &[u8]) -> Option<Vec<u8>> {
        run(b, true)
    }
    pub fn unprotect(b: &[u8]) -> Option<Vec<u8>> {
        run(b, false)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn protect(b: &[u8]) -> Option<Vec<u8>> {
        Some(b.to_vec())
    }
    pub fn unprotect(b: &[u8]) -> Option<Vec<u8>> {
        Some(b.to_vec())
    }
}

pub use imp::{protect, unprotect};
