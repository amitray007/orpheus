// Raw libdispatch bindings — dispatch_async_f and the main queue symbol.
// _dispatch_main_q is an exported global in libdispatch / libSystem.

extern "C" {
    // Take the address of this to get the main queue pointer.
    pub static _dispatch_main_q: std::ffi::c_void;
    pub fn dispatch_async_f(
        queue: *mut std::ffi::c_void,
        context: *mut std::ffi::c_void,
        work: unsafe extern "C" fn(*mut std::ffi::c_void),
    );
}

#[inline]
pub fn main_queue() -> *mut std::ffi::c_void {
    unsafe { &_dispatch_main_q as *const _ as *mut _ }
}
