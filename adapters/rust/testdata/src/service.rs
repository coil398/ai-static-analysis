pub const DEFAULT_GREETING: &str = "Hello";

pub trait Greeter {
    fn greet(&self) -> String;
    fn target(&self) -> &str;
}

pub struct EnglishGreeter {
    name: String,
}

impl EnglishGreeter {
    pub fn new(name: &str) -> Self {
        EnglishGreeter {
            name: name.to_string(),
        }
    }
}

impl Greeter for EnglishGreeter {
    fn greet(&self) -> String {
        format!("{}, {}!", DEFAULT_GREETING, self.name)
    }

    fn target(&self) -> &str {
        &self.name
    }
}
