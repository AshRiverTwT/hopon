// Generates the C# P/Invoke declarations (bindings/NativeMethods.g.cs) from
// the `extern "C"` functions in src/lib.rs. The file is committed so the C#
// shell builds without running cargo first; CI should check it is current.
fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    csbindgen::Builder::default()
        .input_extern_file("src/lib.rs")
        .csharp_dll_name("hopon_ffi")
        .csharp_namespace("HopOn.Native")
        .csharp_class_name("NativeMethods")
        .csharp_class_accessibility("internal")
        .csharp_use_function_pointer(true)
        .generate_csharp_file("bindings/NativeMethods.g.cs")
        .expect("generate C# bindings");
}
