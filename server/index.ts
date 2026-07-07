import { createDefaultWorkerApp, type WorkerEnv } from './app'

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return createDefaultWorkerApp(env).fetch(request)
  },
} satisfies ExportedHandler<WorkerEnv>
