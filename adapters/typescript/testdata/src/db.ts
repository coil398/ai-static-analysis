export interface Storer {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export class Store implements Storer {
  private data: Map<string, string> = new Map();

  get(key: string): string | undefined {
    return this.data.get(key);
  }

  set(key: string, value: string): void {
    this.data.set(key, value);
  }
}

export function newStore(): Storer {
  return new Store();
}
