defmodule Testproject.Greeter do
  @moduledoc "Behaviour for greeting."

  @callback greet(name :: String.t()) :: String.t()
end

defmodule Testproject.ConsoleGreeter do
  @behaviour Testproject.Greeter

  def greet(name) do
    "Hello, #{name}!"
  end
end

defprotocol Testproject.Printer do
  @doc "Protocol for printing."
  def print(this, value)
end

defimpl Testproject.Printer, for: BitString do
  def print(_this, value) do
    IO.puts(value)
  end
end
