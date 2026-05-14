// Re-export bindgen-generated bindings from OUT_DIR.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case, dead_code, improper_ctypes)]
include!(concat!(env!("OUT_DIR"), "/ghostty_bindings.rs"));
