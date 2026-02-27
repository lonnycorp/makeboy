import { stat } from "node:fs/promises"

type MaybePromise<T> = T | Promise<T>

export interface ITask {
    target(): string
    dependencies?(): readonly string[]
    force?(): boolean
    build(): MaybePromise<void>
}

export class Manifest {
    private readonly tasks = new Map<string, ITask>()

    register<TTask extends ITask>(task: TTask): this {
        const target = task.target()
        if (this.tasks.has(target)) {
            throw new Error(`Duplicate task for target: ${target}`)
        }

        this.tasks.set(target, task)
        return this
    }

    compile(): Runner {
        return new Runner(new Map(this.tasks))
    }
}

export class Runner {
    private readonly resolved = new Set<string>()
    private readonly inFlight = new Map<string, Promise<void>>()
    private readonly mtimeCache = new Map<string, number | null>()

    constructor(private readonly tasks: ReadonlyMap<string, ITask>) {}

    async build(target: string): Promise<void> {
        await this.targetBuild(target, [])
    }

    async buildAll(): Promise<void> {
        for (const target of this.tasks.keys()) {
            await this.build(target)
        }
    }

    private async targetBuild(target: string, stack: readonly string[]): Promise<void> {
        const start = stack.indexOf(target)
        if (start >= 0) {
            throw new Error(`Dependency cycle detected: ${this.cycleDescribe(stack, target)}`)
        }

        if (this.resolved.has(target)) {
            return
        }

        const inFlight = this.inFlight.get(target)
        if (inFlight) {
            await inFlight
            return
        }

        const buildPromise = this.targetBuildRun(target, stack)
        this.inFlight.set(target, buildPromise)
        try {
            await buildPromise
        } finally {
            this.inFlight.delete(target)
        }
    }

    private async targetBuildRun(target: string, stack: readonly string[]): Promise<void> {
        const task = this.tasks.get(target)
        if (!task) {
            await this.targetEnsure(target, "dependency")
            this.resolved.add(target)
            return
        }

        const nextStack = [...stack, target]
        const deps = task.dependencies?.() ?? []
        const uniqueDeps = [...new Set(deps)]

        await Promise.all(uniqueDeps.map(async (dep) => this.targetBuild(dep, nextStack)))

        const depMtimes = await Promise.all(
            uniqueDeps.map(async (dep) => {
                const mtime = await this.mtimeGet(dep)
                if (mtime === null) {
                    throw new Error(`Missing dependency: ${dep}`)
                }
                return mtime
            }),
        )

        const targetMtime = await this.mtimeGet(target)
        const forceBuild = task.force?.() === true
        const isStale =
            forceBuild ||
            targetMtime === null ||
            depMtimes.some((depMtime) => depMtime > targetMtime)

        if (isStale) {
            await task.build()
            this.mtimeCache.delete(target)
            await this.targetEnsure(target, "output")
        }

        this.resolved.add(target)
    }

    private cycleDescribe(stack: readonly string[], target: string): string {
        const start = stack.indexOf(target)
        if (start < 0) {
            return [...stack, target].join(" -> ")
        }
        return [...stack.slice(start), target].join(" -> ")
    }

    private async targetEnsure(
        path: string,
        kind: "dependency" | "output",
    ): Promise<void> {
        const mtime = await this.mtimeGet(path)
        if (mtime === null) {
            if (kind === "dependency") {
                throw new Error(`Missing dependency: ${path}`)
            }
            throw new Error(`Build for target "${path}" did not produce output file`)
        }
    }

    private async mtimeRead(path: string): Promise<number | null> {
        try {
            const stats = await stat(path)
            return stats.mtimeMs
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                return null
            }
            throw error
        }
    }

    private async mtimeGet(path: string): Promise<number | null> {
        if (this.mtimeCache.has(path)) {
            return this.mtimeCache.get(path) ?? null
        }

        const mtime = await this.mtimeRead(path)
        this.mtimeCache.set(path, mtime)
        return mtime
    }
}
