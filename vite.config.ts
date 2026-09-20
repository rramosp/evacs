import { spawn } from 'node:child_process'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect } from 'vite'

function createEarthEngineMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      !req.url ||
      (!req.url.startsWith('/api/space-data/sentinel2') &&
        !req.url.startsWith('/api/space-data/sentinel1'))
    ) {
      return next()
    }

    const isSentinel1 = req.url.startsWith('/api/space-data/sentinel1')

    const handleExecution = (
      lat: number,
      lng: number,
      startDate: string,
      endDate: string
    ) => {
      const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
      const scriptName = isSentinel1 ? 'server/ee_sentinel1.py' : 'server/ee_sentinel2.py'
      const scriptPath = path.resolve(process.cwd(), scriptName)

      const proc = spawn(pythonBin, [
        scriptPath,
        String(lng),
        String(lat),
        startDate,
        endDate,
      ])
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      proc.on('close', (code) => {
        res.setHeader('Content-Type', 'application/json')
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{') && l.endsWith('}'))

        if (lines.length > 0) {
          res.statusCode = 200
          res.end(lines[lines.length - 1])
          return
        }

        res.statusCode = 500
        res.end(
          JSON.stringify({
            ok: false,
            error:
              stderr.trim() ||
              `Earth Engine Python script exited with code ${code} without JSON output.`,
          })
        )
      })
    }

    const defaultEnd = new Date().toISOString().slice(0, 10)
    const defaultStartObj = new Date()
    defaultStartObj.setUTCMonth(defaultStartObj.getUTCMonth() - 1)
    const defaultStart = defaultStartObj.toISOString().slice(0, 10)

    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          const lat = Number(parsed.lat ?? 50.8503)
          const lng = Number(parsed.lng ?? 4.3517)
          const startDate = String(parsed.startDate || defaultStart)
          const endDate = String(parsed.endDate || defaultEnd)
          handleExecution(lat, lng, startDate, endDate)
        } catch {
          handleExecution(50.8503, 4.3517, defaultStart, defaultEnd)
        }
      })
      return
    }

    const urlObj = new URL(req.url, 'http://localhost')
    const lat = Number(urlObj.searchParams.get('lat') ?? 50.8503)
    const lng = Number(urlObj.searchParams.get('lng') ?? 4.3517)
    const startDate = urlObj.searchParams.get('startDate') || defaultStart
    const endDate = urlObj.searchParams.get('endDate') || defaultEnd
    handleExecution(lat, lng, startDate, endDate)
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'earth-engine-server-api',
      configureServer(server) {
        server.middlewares.use(createEarthEngineMiddleware())
      },
      configurePreviewServer(server) {
        server.middlewares.use(createEarthEngineMiddleware())
      },
    },
  ],
})
