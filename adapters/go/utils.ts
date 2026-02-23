// Go adapter utilities — subprocess execution, file hashing, generated detection

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function exec(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function whichTool(name: string): Promise<string | null> {
  try {
    const result = await exec(["which", name]);
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

export async function hashFile(path: string): Promise<string> {
  const file = Bun.file(path);
  const buf = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  return `sha256:${hasher.digest("hex")}`;
}

const GENERATED_MARKER = "// Code generated";

export async function isGenerated(path: string): Promise<boolean> {
  const file = Bun.file(path);
  // Read first 1KB to check for generated marker
  const stream = file.stream();
  const reader = stream.getReader();
  try {
    const { value } = await reader.read();
    if (!value) return false;
    const head = new TextDecoder().decode(value.slice(0, 1024));
    return head.includes(GENERATED_MARKER);
  } finally {
    reader.releaseLock();
  }
}
