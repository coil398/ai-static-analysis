from abc import ABC, abstractmethod


class Greeter(ABC):
    """Abstract greeter interface."""

    @abstractmethod
    def greet(self, name: str) -> str: ...


class HelloService(Greeter):
    """Concrete implementation of Greeter."""

    def __init__(self, prefix: str = "Hello") -> None:
        self.prefix = prefix

    def greet(self, name: str) -> str:
        return f"{self.prefix}, {name}!"

    def farewell(self, name: str) -> str:
        return f"Goodbye, {name}!"


def create_service(prefix: str = "Hello") -> HelloService:
    """Factory function."""
    return HelloService(prefix)
