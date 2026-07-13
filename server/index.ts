import { createDefaultWorkerApp, type WorkerApp, type WorkerEnv } from './app'

let application: WorkerApp | undefined

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    application ??= createDefaultWorkerApp(env)

    return application.fetch(request)
  },
} satisfies ExportedHandler<WorkerEnv>
