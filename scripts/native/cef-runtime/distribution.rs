fn main() {
    match cef::sys::get_cef_dir() {
        Some(path) => println!("{}", path.display()),
        None => std::process::exit(1),
    }
}
