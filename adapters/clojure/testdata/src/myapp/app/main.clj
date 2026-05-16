(ns myapp.app.main
  (:require [myapp.lib.greet :as greet])
  (:gen-class))

(defn -main [& _args]
  (println (greet/greet "world")))
