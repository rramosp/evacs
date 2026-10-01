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

import fs from 'node:fs'

let cachedMetroJson: string | null = null
let cachedMetroMtime = 0

let cachedScenariosJson: string | null = null
let cachedScenariosSignature = ''

function serveScenariosPklData(res: ServerResponse) {
  const scenariosDir = path.resolve(process.cwd(), 'data/scenarios')
  let currentSig = ''
  try {
    const files = fs
      .readdirSync(scenariosDir)
      .filter((f) => f.endsWith('.pkl'))
      .sort()
    currentSig = files
      .map((f) => `${f}:${fs.statSync(path.join(scenariosDir, f)).mtimeMs}`)
      .join('|')
  } catch {
    // Fallback to running script directly
  }

  if (cachedScenariosJson && currentSig && currentSig === cachedScenariosSignature) {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 200
    res.end(cachedScenariosJson)
    return
  }

  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), 'server/scenarios.py')
  const proc = spawn(pythonBin, [scriptPath])
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
      const payload = lines[lines.length - 1]
      cachedScenariosJson = payload
      cachedScenariosSignature = currentSig
      res.statusCode = 200
      res.end(payload)
      return
    }

    res.statusCode = 500
    res.end(
      JSON.stringify({
        ok: false,
        error:
          stderr.trim() ||
          `server/scenarios.py exited with code ${code} without JSON output.`,
      })
    )
  })
}

function serveBrusselsMetroParquetData(res: ServerResponse) {
  const linesPath = path.resolve(process.cwd(), 'data/brussels_metro_lines.parquet')
  const stationsPath = path.resolve(process.cwd(), 'data/brussels_metro_stations.parquet')
  let currentMtime = 0
  try {
    currentMtime =
      fs.statSync(linesPath).mtimeMs + fs.statSync(stationsPath).mtimeMs
  } catch {
    // Fallback to running script directly
  }

  if (cachedMetroJson && currentMtime > 0 && currentMtime === cachedMetroMtime) {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 200
    res.end(cachedMetroJson)
    return
  }

  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), 'server/brussels_metro.py')
  const proc = spawn(pythonBin, [scriptPath])
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
      const payload = lines[lines.length - 1]
      cachedMetroJson = payload
      cachedMetroMtime = currentMtime
      res.statusCode = 200
      res.end(payload)
      return
    }

    res.statusCode = 500
    res.end(
      JSON.stringify({
        ok: false,
        error:
          stderr.trim() ||
          `server/brussels_metro.py exited with code ${code} without JSON output.`,
      })
    )
  })
}

function createSpaceDataMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url) {
      return next()
    }

    // 0a. Preset Scenarios Reader Endpoint (data/scenarios/*.pkl)
    if (req.url.startsWith('/api/scenarios')) {
      serveScenariosPklData(res)
      return
    }

    // 0b. Brussels Metro Parquet Reader Endpoint (data/brussels_metro_lines.parquet & data/brussels_metro_stations.parquet)
    if (req.url.startsWith('/api/brussels-metro/network')) {
      serveBrusselsMetroParquetData(res)
      return
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
