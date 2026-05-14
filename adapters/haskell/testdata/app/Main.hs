module Main where

import Lib.Greet (greet)

main :: IO ()
main = putStrLn (greet "world")
