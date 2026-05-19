(ns myapp.lib.protocols)

(defprotocol Greeter
  "Protocol for greeting."
  (greet [this name] "Returns a greeting for the given name."))

(defrecord ConsoleGreeter []
  Greeter
  (greet [_this name]
    (str "Hello, " name "!")))
