import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect } from 'vite'

function runPythonScript(
  scriptRelPath: string,
  args: string[],
  res: ServerResponse
) {
  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), scriptRelPath)

  const proc = spawn(pythonBin, [scriptPath, ...args])
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
          `Python script (${scriptRelPath}) exited with code ${code} without JSON output.`,
      })
    )
  })
}

function cleanupTmpDownloadsOnStartup() {
  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), 'scripts/download_glofas.py')
  const proc = spawn(pythonBin, [scriptPath, '--cleanup-only'])
  proc.on('error', () => {
    // Non-fatal startup cleanup
  })
}

function createSpaceDataMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url) {
      return next()
    }

    // 1. CEMS GloFAS River Discharge Forecast Endpoints
    if (req.url.startsWith('/api/cems-glofas/cleanup')) {
      const today = new Date().toISOString().slice(0, 10)
      runPythonScript('scripts/download_glofas.py', ['--date', today, '--cleanup-only'], res)
      return
    }

    if (req.url.startsWith('/api/cems-glofas/forecast')) {
      const defaultDate = new Date().toISOString().slice(0, 10)

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
            const date = String(parsed.date || defaultDate)
            const radius = Number(parsed.radius ?? 100000)
            runPythonScript(
              'scripts/download_glofas.py',
              [
                '--lat',
                String(lat),
                '--lon',
                String(lng),
                '--date',
                date,
                '--radius',
                String(radius),
                '--json',
              ],
              res
            )
          } catch {
            runPythonScript(
              'scripts/download_glofas.py',
              ['--lat', '50.8503', '--lon', '4.3517', '--date', defaultDate, '--json'],
              res
            )
          }
        })
        return
      }

      const urlObj = new URL(req.url, 'http://localhost')
      const lat = Number(urlObj.searchParams.get('lat') ?? 50.8503)
      const lng = Number(urlObj.searchParams.get('lng') ?? 4.3517)
      const date = urlObj.searchParams.get('date') || defaultDate
      runPythonScript(
        'scripts/download_glofas.py',
        ['--lat', String(lat), '--lon', String(lng), '--date', date, '--json'],
        res
      )
      return
    }

    // 2. Google Earth Engine Sentinel-2 Optical & Sentinel-1 SAR Endpoints
    if (
      !req.url.startsWith('/api/space-data/sentinel2') &&
      !req.url.startsWith('/api/space-data/sentinel1')
    ) {
      return next()
    }

    const isSentinel1 = req.url.startsWith('/api/space-data/sentinel1')
    const scriptName = isSentinel1 ? 'server/ee_sentinel1.py' : 'server/ee_sentinel2.py'

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
          runPythonScript(scriptName, [String(lng), String(lat), startDate, endDate], res)
        } catch {
          runPythonScript(scriptName, ['4.3517', '50.8503', defaultStart, defaultEnd], res)
        }
      })
      return
    }

    const urlObj = new URL(req.url, 'http://localhost')
    const lat = Number(urlObj.searchParams.get('lat') ?? 50.8503)
    const lng = Number(urlObj.searchParams.get('lng') ?? 4.3517)
    const startDate = urlObj.searchParams.get('startDate') || defaultStart
    const endDate = urlObj.searchParams.get('endDate') || defaultEnd
    runPythonScript(scriptName, [String(lng), String(lat), startDate, endDate], res)
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'space-data-server-api',
      configureServer(server) {
        cleanupTmpDownloadsOnStartup()
        server.middlewares.use(createSpaceDataMiddleware())
      },
      configurePreviewServer(server) {
        cleanupTmpDownloadsOnStartup()
        server.middlewares.use(createSpaceDataMiddleware())
      },
    },
  ],
})
