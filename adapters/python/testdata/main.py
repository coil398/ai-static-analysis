from mypackage.service import create_service, HelloService


def main() -> None:
    service = create_service("Hi")
    message = service.greet("World")
    print(message)


if __name__ == "__main__":
    main()
