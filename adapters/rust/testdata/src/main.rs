mod service;

use service::{Greeter, EnglishGreeter};

fn main() {
    let greeter = EnglishGreeter::new("World");
    let msg = greeter.greet();
    println!("{}", msg);
}
