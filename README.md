# makeboy

![ci](https://github.com/tlonny/makeboy/actions/workflows/check.yml/badge.svg)

A minimal file-target build graph runner for TypeScript.

## Installation

```bash
npm install makeboy
```

## Quick Look

```typescript
import { Manifest, type ITask } from "makeboy"
import { writeFile } from "node:fs/promises"

class BuildTask implements ITask {
    constructor(
        private readonly path: string,
        private readonly deps: readonly string[] = [],
    ) {}

    target(): string {
        return this.path
    }

    dependencies(): readonly string[] {
        return this.deps
    }

    async build(): Promise<void> {
        await writeFile(this.path, "built")
    }
}

const manifest = new Manifest().register(
    new BuildTask("./dist/output.txt", ["./src/input.txt"]),
)

await manifest.compile().buildAll()
```

## Force Rebuilds

If a task should run every time, implement `force()` and return `true`.

```typescript
class AlwaysTask implements ITask {
    target(): string {
        return "./dist/version.txt"
    }

    force(): boolean {
        return true
    }

    async build(): Promise<void> {
        await writeFile("./dist/version.txt", String(Date.now()))
    }
}
```

## Parallel Execution

Dependencies for a target are built in parallel. In other words, siblings in the dependency graph can run at the same time, while dependency ordering is still respected.

This usually improves throughput, but tasks that share a mutable global resource (single output file, shared cache directory, external tool lock, etc.) may need explicit coordination.

## Sequential Mitigation (Global Semaphore)

If you need to guarantee sequential execution for critical sections, gate those sections with a global semaphore.

```typescript
const globalBuildSemaphore = new MySemaphore(1)

class SerializedTask implements ITask {
    target(): string {
        return "./dist/safe-output.txt"
    }

    async build(): Promise<void> {
        const release = await globalBuildSemaphore.acquire()
        try {
            // Critical section: only one task at a time.
            await writeFile("./dist/safe-output.txt", "safe")
        } finally {
            release()
        }
    }
}
```
