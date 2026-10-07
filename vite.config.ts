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

let cachedOverlaysJson: string | null = null
let cachedOverlaysSignature = ''

function serveDataOverlays(res: ServerResponse) {
  const overlaysDir = path.resolve(process.cwd(), 'data/overlays')
  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), 'server/overlays.py')
  let currentSig = ''
  try {
    const scriptMtime = fs.statSync(scriptPath).mtimeMs
    const files = fs
      .readdirSync(overlaysDir)
      .filter((f) => {
        const lower = f.toLowerCase()
        return (
          lower.endsWith('.geojson') ||
          lower.endsWith('.tif') ||
          lower.endsWith('.tiff') ||
          lower.endsWith('.geotif') ||
          lower.endsWith('.geotiff')
        )
      })
      .sort()
    currentSig = `script:${scriptMtime}|` + files
      .map((f) => `${f}:${fs.statSync(path.join(overlaysDir, f)).mtimeMs}`)
      .join('|')
  } catch {
    // Fallback to running script directly
  }

  if (cachedOverlaysJson && currentSig === cachedOverlaysSignature) {
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = 200
    res.end(cachedOverlaysJson)
    return
  }

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
      cachedOverlaysJson = payload
      cachedOverlaysSignature = currentSig
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
          `server/overlays.py exited with code ${code} without JSON output.`,
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

function serveEvaccastRouting(body: string, res: ServerResponse) {
  const pythonBin = process.env.EE_PYTHON || '/opt/conda/envs/evacs/bin/python'
  const scriptPath = path.resolve(process.cwd(), 'server/evaccast_routing.py')
  const proc = spawn(pythonBin, [scriptPath])
  let stdout = ''
  let stderr = ''
  let finished = false

  res.on('close', () => {
    if (!finished && !proc.killed) {
      proc.kill('SIGTERM')
    }
  })

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  proc.on('close', (code) => {
    finished = true
    if (res.writableEnded || res.destroyed) {
      return
    }
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
          `server/evaccast_routing.py exited with code ${code} without JSON output.`,
      })
    )
  })

  proc.stdin.write(body)
  proc.stdin.end()
}

const INSTALLED_ROUTING_ALGORITHMS = ['Basic OSM', 'evaccast_v1'] as const

function getRoutingAlgorithmCacheFolder(algorithm: string): string {
  const trimmed = String(algorithm || '').trim()
  if (trimmed === 'Basic OSM' || trimmed.toLowerCase() === 'basic_osm') {
    return 'basic_osm'
  }
  if (trimmed === 'evaccast_v1') {
    return 'evaccast_v1'
  }
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'default'
  )
}

function ensureRoutingCacheDirs() {
  const baseCacheDir = path.resolve(process.cwd(), 'cache/routing')
  try {
    fs.mkdirSync(baseCacheDir, { recursive: true })
    for (const algo of INSTALLED_ROUTING_ALGORITHMS) {
      const folder = getRoutingAlgorithmCacheFolder(algo)
      fs.mkdirSync(path.join(baseCacheDir, folder), { recursive: true })
    }
  } catch {
    // Non-fatal directory initialization
  }
}

ensureRoutingCacheDirs()

function sanitizeCacheHash(rawHash: string): string {
  return String(rawHash || '')
    .trim()
    .replace(/[^a-fA-F0-9_-]/g, '')
}

function serveRoutingCache(
  req: Connect.IncomingMessage,
  res: ServerResponse
) {
  ensureRoutingCacheDirs()
  const baseCacheDir = path.resolve(process.cwd(), 'cache/routing')

  if (req.method === 'GET') {
    const urlObj = new URL(req.url || '/api/routing/cache', 'http://localhost')
    const algorithm = urlObj.searchParams.get('algorithm') || 'Basic OSM'
    const hash = sanitizeCacheHash(urlObj.searchParams.get('hash') || '')
    const folder = getRoutingAlgorithmCacheFolder(algorithm)

    res.setHeader('Content-Type', 'application/json')
    if (!hash) {
      res.statusCode = 400
      res.end(JSON.stringify({ ok: false, hit: false, error: 'Missing hash parameter' }))
      return
    }

    const algoDir = path.join(baseCacheDir, folder)
    const filePath = path.join(algoDir, `${hash}.json`)
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.routes)) {
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: true,
              hit: true,
              hash,
              algorithm,
              folder,
              path: `cache/routing/${folder}/${hash}.json`,
              routes: parsed.routes,
              createdAt: parsed.createdAt,
            })
          )
          return
        }
      }
    } catch {
      // Treat corrupted or unreadable file as cache miss
    }

    res.statusCode = 200
    res.end(
      JSON.stringify({
        ok: true,
        hit: false,
        hash,
        algorithm,
        folder,
        path: `cache/routing/${folder}/${hash}.json`,
      })
    )
    return
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      try {
        const parsed = JSON.parse(body || '{}')
        const algorithm = String(parsed.algorithm || 'Basic OSM')
        const hash = sanitizeCacheHash(String(parsed.hash || ''))
        const routes = parsed.routes
        const stringifiedParameters =
          typeof parsed.stringifiedParameters === 'string'
            ? parsed.stringifiedParameters
            : undefined

        if (!hash || !Array.isArray(routes)) {
          res.statusCode = 400
          res.end(
            JSON.stringify({
              ok: false,
              error: 'Both a valid hash identifier and routes array are required.',
            })
          )
          return
        }

        const folder = getRoutingAlgorithmCacheFolder(algorithm)
        const algoDir = path.join(baseCacheDir, folder)
        fs.mkdirSync(algoDir, { recursive: true })

        const filePath = path.join(algoDir, `${hash}.json`)
        const cachePayload = {
          hash,
          algorithm,
          folder,
          createdAt: new Date().toISOString(),
          stringifiedParameters,
          routes,
        }
        fs.writeFileSync(filePath, JSON.stringify(cachePayload, null, 2), 'utf-8')

        res.statusCode = 200
        res.end(
          JSON.stringify({
            ok: true,
            saved: true,
            hash,
            algorithm,
            folder,
            path: `cache/routing/${folder}/${hash}.json`,
          })
        )
      } catch (err) {
        res.statusCode = 500
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        )
      }
    })
    return
  }

  res.setHeader('Content-Type', 'application/json')
  res.statusCode = 405
  res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed. Use GET or POST.' }))
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

    // 0b. Data Overlays Reader Endpoint (data/overlays/*.geojson, *.tif, *.tiff, *.geotif, *.geotiff)
    if (req.url.startsWith('/api/overlays')) {
      serveDataOverlays(res)
      return
    }

    // 0c. Brussels Metro Parquet Reader Endpoint (data/brussels_metro_lines.parquet & data/brussels_metro_stations.parquet)
    if (req.url.startsWith('/api/brussels-metro/network')) {
      serveBrusselsMetroParquetData(res)
      return
    }

    // 0d. Disk Routing Cache Endpoint (cache/routing/<algorithm>/<hash>.json)
    if (req.url.startsWith('/api/routing/cache')) {
      serveRoutingCache(req, res)
      return
    }

    // 0e. evaccast_v1 Routing Algorithm Endpoint (server/evaccast_routing.py)
    if (req.url.startsWith('/api/routing/evaccast-v1')) {
      if (req.method !== 'POST') {
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = 405
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed. Use POST.' }))
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        serveEvaccastRouting(body, res)
      })
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

    // 1.b AI Assessment LLM Endpoints (OpenAI-compatible API configured via config.yaml)
    if (req.url.startsWith('/api/ai-assessment/')) {
      const readConfigYaml = () => {
        const configPath = path.resolve(process.cwd(), 'config.yaml')
        let modelEndpoint = 'https://generativelanguage.googleapis.com/v1beta/openai'
        let model = 'gemini-3.8-flash'
        let apiKeyEnv = 'OPENAI_API_KEY'

        if (fs.existsSync(configPath)) {
          const rawYaml = fs.readFileSync(configPath, 'utf-8')
          for (const rawLine of rawYaml.split(/\r?\n/)) {
            const trimmed = rawLine.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const colonIdx = trimmed.indexOf(':')
            if (colonIdx === -1) continue
            const key = trimmed.slice(0, colonIdx).trim()
            let val = trimmed.slice(colonIdx + 1).trim()
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1).trim()
            } else {
              const commentIdx = val.indexOf(' #')
              if (commentIdx !== -1) {
                val = val.slice(0, commentIdx).trim()
              }
            }
            if (key === 'model_endpoint' && val) modelEndpoint = val
            else if (key === 'model' && val) model = val
            else if (key === 'api_key_env' && val) apiKeyEnv = val
          }
        }

        return { modelEndpoint, model, apiKeyEnv }
      }

      if (req.url.startsWith('/api/ai-assessment/config')) {
        res.setHeader('Content-Type', 'application/json')
        try {
          const cfg = readConfigYaml()
          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: true,
              modelEndpoint: cfg.modelEndpoint,
              model: cfg.model,
              apiKeyEnv: cfg.apiKeyEnv,
            })
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.statusCode = 500
          res.end(JSON.stringify({ ok: false, error: message }))
        }
        return
      }

      if (req.url.startsWith('/api/ai-assessment/send')) {
        if (req.method !== 'POST') {
          res.setHeader('Content-Type', 'application/json')
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed. Use POST.' }))
          return
        }

        let body = ''
        req.on('data', (chunk) => {
          body += chunk.toString()
        })
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          try {
            const parsed = JSON.parse(body || '{}')
            const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
            if (!prompt) {
              res.statusCode = 400
              res.end(JSON.stringify({ ok: false, error: 'Prompt is empty.' }))
              return
            }

            const { modelEndpoint, model, apiKeyEnv } = readConfigYaml()
            const apiKey = process.env[apiKeyEnv]
            if (!apiKey || !apiKey.trim()) {
              res.statusCode = 500
              res.end(
                JSON.stringify({
                  ok: false,
                  error: `Environment variable "${apiKeyEnv}" (specified in config.yaml) is not set or empty.`,
                })
              )
              return
            }

          const cleanBase = modelEndpoint.replace(/\/+$/, '')
          const requestUrl = cleanBase.endsWith('/chat/completions')
            ? cleanBase
            : `${cleanBase}/chat/completions`

          const upstreamRes = await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey.trim()}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: 'user',
                  content: prompt,
                },
              ],
            }),
          })

          const rawText = await upstreamRes.text()
          let responseData: Record<string, unknown> | null = null
          try {
            responseData = JSON.parse(rawText)
          } catch {
            responseData = null
          }

          if (!upstreamRes.ok) {
            const errObj = responseData?.error as Record<string, unknown> | undefined
            const upstreamMsg =
              (typeof errObj?.message === 'string' && errObj.message) ||
              rawText ||
              `HTTP ${upstreamRes.status} ${upstreamRes.statusText}`
            res.statusCode = upstreamRes.status
            res.end(
              JSON.stringify({
                ok: false,
                error: `LLM request failed (${upstreamRes.status} on ${model}): ${upstreamMsg}`,
              })
            )
            return
          }

          const choices = Array.isArray(responseData?.choices) ? responseData.choices : []
          const firstChoice = choices[0] as Record<string, unknown> | undefined
          const messageObj = firstChoice?.message as Record<string, unknown> | undefined
          const content =
            typeof messageObj?.content === 'string' ? messageObj.content : ''

          if (!content) {
            res.statusCode = 502
            res.end(
              JSON.stringify({
                ok: false,
                error: 'LLM response succeeded but returned empty message content.',
              })
            )
            return
          }

          res.statusCode = 200
          res.end(
            JSON.stringify({
              ok: true,
              content,
              model,
              modelEndpoint,
            })
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.statusCode = 500
          res.end(
            JSON.stringify({
              ok: false,
              error: `Failed to send AI assessment request: ${message}`,
            })
          )
        }
        })
        return
      }
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
