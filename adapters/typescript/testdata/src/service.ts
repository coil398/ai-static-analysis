import { type Storer, newStore } from "./db";

export class Service {
  private store: Storer;

  constructor() {
    this.store = newStore();
  }

  hello(name: string): string {
    const greeting = `Hello, ${name}!`;
    this.store.set(name, greeting);
    return greeting;
  }
}

export function newService(): Service {
  return new Service();
}
