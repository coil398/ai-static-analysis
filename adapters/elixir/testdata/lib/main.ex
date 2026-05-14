defmodule Testproject.Main do
  alias Testproject.Greet

  def run do
    IO.puts(Greet.greet("world"))
  end
end
