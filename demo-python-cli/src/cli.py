from calculator import add, compound_interest


def main() -> None:
    print({"sum": add(2, 3), "growth": compound_interest(1000, 0.05, 3)})


if __name__ == "__main__":
    main()
