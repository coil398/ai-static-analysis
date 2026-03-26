import { newService } from "./service";

function run(): void {
  const svc = newService();
  const result = svc.hello("world");
  console.log(result);
}

run();
