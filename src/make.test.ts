import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { Manifest, type ITask } from "./make"

const testDirs: string[] = []

class FileTask implements ITask {
    constructor(
        private readonly outputPath: string,
        private readonly deps: readonly string[] = [],
        private readonly buildFn: () => Promise<void> | void = () => {},
        private readonly forceBuild = false,
    ) {}

    target(): string {
        return this.outputPath
    }

    dependencies(): readonly string[] {
        return this.deps
    }

    force(): boolean {
        return this.forceBuild
    }

    build(): Promise<void> | void {
        return this.buildFn()
    }
}

async function createTestDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "make-test-"))
    testDirs.push(dir)
    return dir
}

async function touchWithOffset(path: string, offsetMs: number): Promise<void> {
    const base = Date.now() + offsetMs
    const date = new Date(base)
    await utimes(path, date, date)
}

afterEach(async () => {
    await Promise.all(
        testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
})

describe("Manifest / Runner", () => {
    test("builds when target is missing", async () => {
        const dir = await createTestDir()
        const dep = join(dir, "dep.txt")
        const target = join(dir, "target.txt")
        await writeFile(dep, "dep")

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(target, [dep], async () => {
                buildCalls += 1
                await writeFile(target, "built")
            }),
        )

        await manifest.compile().build(target)

        expect(buildCalls).toBe(1)
        expect(await Bun.file(target).exists()).toBe(true)
    })

    test("skips build when target is up to date", async () => {
        const dir = await createTestDir()
        const dep = join(dir, "dep.txt")
        const target = join(dir, "target.txt")
        await writeFile(dep, "dep")
        await writeFile(target, "target")
        await touchWithOffset(dep, -2000)
        await touchWithOffset(target, 0)

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(target, [dep], async () => {
                buildCalls += 1
            }),
        )

        await manifest.compile().build(target)
        expect(buildCalls).toBe(0)
    })

    test("forces build when task opts in and target is up to date", async () => {
        const dir = await createTestDir()
        const dep = join(dir, "dep.txt")
        const target = join(dir, "target.txt")
        await writeFile(dep, "dep")
        await writeFile(target, "target")
        await touchWithOffset(dep, -2000)
        await touchWithOffset(target, 0)

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(
                target,
                [dep],
                async () => {
                    buildCalls += 1
                },
                true,
            ),
        )

        await manifest.compile().build(target)
        expect(buildCalls).toBe(1)
    })

    test("forces build for zero-dependency task when task opts in", async () => {
        const dir = await createTestDir()
        const target = join(dir, "target.txt")
        await writeFile(target, "target")
        await touchWithOffset(target, 0)

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(
                target,
                [],
                async () => {
                    buildCalls += 1
                    await writeFile(target, "rebuilt")
                },
                true,
            ),
        )

        await manifest.compile().build(target)
        expect(buildCalls).toBe(1)
    })

    test("rebuilds when any dependency is newer", async () => {
        const dir = await createTestDir()
        const dep = join(dir, "dep.txt")
        const target = join(dir, "target.txt")
        await writeFile(dep, "dep")
        await writeFile(target, "target")
        await touchWithOffset(target, -2000)
        await touchWithOffset(dep, 0)

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(target, [dep], async () => {
                buildCalls += 1
                await writeFile(target, "rebuilt")
            }),
        )

        await manifest.compile().build(target)
        expect(buildCalls).toBe(1)
    })

    test("fails when a leaf dependency is missing", async () => {
        const dir = await createTestDir()
        const target = join(dir, "target.txt")
        const missingA = join(dir, "missing-a.txt")
        const missingB = join(dir, "missing-b.txt")

        let buildCalls = 0
        const manifest = new Manifest().register(
            new FileTask(target, [missingA, missingB], async () => {
                buildCalls += 1
                await writeFile(target, "built")
            }),
        )

        await expect(manifest.compile().build(target)).rejects.toThrow("Missing dependency:")
        expect(buildCalls).toBe(0)
    })

    test("builds dependencies in parallel", async () => {
        const dir = await createTestDir()
        const depA = join(dir, "dep-a.txt")
        const depB = join(dir, "dep-b.txt")
        const target = join(dir, "target.txt")
        const started: string[] = []

        let depAResolve!: () => void
        let depBResolve!: () => void
        const depAGate = new Promise<void>((resolve) => {
            depAResolve = resolve
        })
        const depBGate = new Promise<void>((resolve) => {
            depBResolve = resolve
        })

        const manifest = new Manifest()
            .register(new FileTask(depA, [], async () => {
                started.push("a")
                await depAGate
                await writeFile(depA, "a")
            }))
            .register(new FileTask(depB, [], async () => {
                started.push("b")
                await depBGate
                await writeFile(depB, "b")
            }))
            .register(new FileTask(target, [depA, depB], async () => {
                await writeFile(target, "target")
            }))

        const buildPromise = manifest.compile().build(target)

        for (let i = 0; i < 20 && started.length < 2; i += 1) {
            await Bun.sleep(1)
        }

        expect(started).toContain("a")
        expect(started).toContain("b")

        depAResolve()
        depBResolve()
        await buildPromise
    })

    test("builds shared dependency once when branches run in parallel", async () => {
        const dir = await createTestDir()
        const c = join(dir, "c.txt")
        const a = join(dir, "a.txt")
        const b = join(dir, "b.txt")
        const target = join(dir, "target.txt")
        let cBuildCalls = 0

        const manifest = new Manifest()
            .register(new FileTask(c, [], async () => {
                cBuildCalls += 1
                await Bun.sleep(5)
                await writeFile(c, "c")
            }))
            .register(new FileTask(a, [c], async () => {
                await writeFile(a, "a")
            }))
            .register(new FileTask(b, [c], async () => {
                await writeFile(b, "b")
            }))
            .register(new FileTask(target, [a, b], async () => {
                await writeFile(target, "target")
            }))

        await manifest.compile().build(target)

        expect(cBuildCalls).toBe(1)
    })

    test("supports tasks without dependencies method", async () => {
        const dir = await createTestDir()
        const target = join(dir, "target.txt")

        const manifest = new Manifest().register({
            target: () => target,
            build: async () => {
                await writeFile(target, "target")
            },
        })

        await manifest.compile().build(target)
        expect(await Bun.file(target).exists()).toBe(true)
    })

    test("treats root target with no rule as leaf when file exists", async () => {
        const dir = await createTestDir()
        const existing = join(dir, "existing.txt")
        await writeFile(existing, "content")

        const manifest = new Manifest()
        await expect(manifest.compile().build(existing)).resolves.toBeUndefined()
    })

    test("fails root target with no rule when leaf file is missing", async () => {
        const dir = await createTestDir()
        const missing = join(dir, "missing.txt")

        const manifest = new Manifest()
        await expect(manifest.compile().build(missing)).rejects.toThrow(
            `Missing dependency: ${missing}`,
        )
    })

    test("detects dependency cycles", async () => {
        const dir = await createTestDir()
        const a = join(dir, "a.txt")
        const b = join(dir, "b.txt")

        const manifest = new Manifest()
            .register(new FileTask(a, [b], async () => {
                await writeFile(a, "a")
            }))
            .register(new FileTask(b, [a], async () => {
                await writeFile(b, "b")
            }))

        await expect(manifest.compile().build(a)).rejects.toThrow(
            `Dependency cycle detected: ${a} -> ${b} -> ${a}`,
        )
    })

    test("throws on duplicate task", () => {
        const manifest = new Manifest()

        manifest.register(new FileTask("same", []))
        expect(() => manifest.register(new FileTask("same", []))).toThrow(
            "Duplicate task for target: same",
        )
    })

    test("throws if build does not produce target", async () => {
        const dir = await createTestDir()
        const target = join(dir, "target.txt")

        const manifest = new Manifest().register(new FileTask(target, []))

        await expect(manifest.compile().build(target)).rejects.toThrow(
            `Build for target "${target}" did not produce output file`,
        )
    })

    test("uses mtime cache for repeated mtime lookups", async () => {
        const dir = await createTestDir()
        const dep = join(dir, "dep.txt")
        const target = join(dir, "target.txt")
        await writeFile(dep, "dep")
        await writeFile(target, "target")
        await touchWithOffset(dep, -2000)
        await touchWithOffset(target, 0)

        const manifest = new Manifest().register(new FileTask(target, [dep]))
        const state = manifest.compile() as unknown as {
            mtimeGet: (path: string) => Promise<number | null>
            mtimeRead: (path: string) => Promise<number | null>
        }

        let reads = 0
        const originalMtimeRead = state.mtimeRead.bind(state)
        state.mtimeRead = async (path: string) => {
            reads += 1
            return originalMtimeRead(path)
        }

        await state.mtimeGet(dep)
        await state.mtimeGet(dep)
        expect(reads).toBe(1)
    })

    test("buildAll builds all registered targets in deterministic serial order", async () => {
        const dir = await createTestDir()
        const a = join(dir, "a.txt")
        const b = join(dir, "b.txt")
        const order: string[] = []

        const manifest = new Manifest()
            .register(new FileTask(a, [], async () => {
                order.push("a")
                await writeFile(a, "a")
            }))
            .register(new FileTask(b, [], async () => {
                order.push("b")
                await writeFile(b, "b")
            }))

        await manifest.compile().buildAll()
        expect(order).toEqual(["a", "b"])
    })

    test("buildAll fails fast on first error", async () => {
        const dir = await createTestDir()
        const a = join(dir, "a.txt")
        const b = join(dir, "b.txt")
        let bBuilt = false

        const manifest = new Manifest()
            .register(new FileTask(a, [], async () => {
                throw new Error("boom")
            }))
            .register(new FileTask(b, [], async () => {
                bBuilt = true
                await writeFile(b, "b")
            }))

        await expect(manifest.compile().buildAll()).rejects.toThrow("boom")
        expect(bBuilt).toBe(false)
    })

    test("buildAll still errors when a rule dependency is missing", async () => {
        const dir = await createTestDir()
        const a = join(dir, "a.txt")
        const missingLeaf = join(dir, "missing-leaf.txt")

        const manifest = new Manifest().register(
            new FileTask(a, [missingLeaf], async () => {
                await writeFile(a, "a")
            }),
        )

        await expect(manifest.compile().buildAll()).rejects.toThrow(
            `Missing dependency: ${missingLeaf}`,
        )
    })
})
