import WebSocket from 'ws'
import express, { Express, Response } from 'express'
import debug from 'debug'
import * as http from 'http'
import { json } from 'body-parser'
import { createHmac } from 'crypto'
import { camelCase } from 'koishi-utils'
import { Meta, VersionInfo } from './meta'
import { App, AppOptions } from './app'
import { CQResponse } from './sender'

const showServerLog = debug('koishi:server')

// @ts-ignore: @types/debug does not include the property
showServerLog.inspectOpts.depth = 0

export abstract class Server {
  public apps: App[] = []
  public version: VersionInfo
  private _appMap: Record<number, App> = {}
  private _isListening = false

  protected abstract _listen (): Promise<void>
  abstract close (): void

  constructor (app: App) {
    this.bind(app)
  }

  protected _handleData (data: any, res?: Response) {
    const meta = camelCase(data) as Meta
    if (!this._appMap[meta.selfId]) {
      const index = this.apps.findIndex(app => !app.options.selfId)
      if (index < 0) {
        if (res) res.sendStatus(403)
        return
      }
      this._appMap[meta.selfId] = this.apps[index]
      this.apps[index].options.selfId = meta.selfId
      this.apps[index]._registerSelfId()
    }
    const app = this._appMap[meta.selfId]
    if (res) res.sendStatus(200)
    showServerLog('receive %o', meta)
    app.dispatchMeta(meta)
  }

  bind (app: App) {
    this.apps.push(app)
    if (app.options.selfId) {
      this._appMap[app.options.selfId] = app
    }
    return this
  }

  async listen () {
    if (this._isListening) return
    this._isListening = true
    await this._listen()
    for (const app of this.apps) {
      app.receiver.emit('connected', app)
    }
  }
}

export class HttpServer extends Server {
  // https://github.com/microsoft/TypeScript/issues/31280
  public express: Express = express().use(json())
  public server: http.Server

  constructor (app: App) {
    super(app)

    if (app.options.secret) {
      this.express.use((req, res, next) => {
        const signature = req.header('x-signature')
        if (!signature) return res.sendStatus(401)
        const body = JSON.stringify(req.body)
        const sig = createHmac('sha1', app.options.secret).update(body).digest('hex')
        if (signature !== `sha1=${sig}`) return res.sendStatus(403)
        return next()
      })
    }

    this.express.use((req, res) => {
      this._handleData(req.body, res)
    })
  }

  async _listen () {
    const { port } = this.apps[0].options
    this.server = this.express.listen(port)
    if (this.apps[0].options.httpServer) {
      try {
        this.version = await this.apps[0].sender.getVersionInfo()
      } catch (error) {
        throw new Error('authorization failed')
      }
    }
    showServerLog('listen to port', port)
  }

  close () {
    if (this.server) this.server.close()
    showServerLog('http server closed')
  }
}

let counter = 0

export class WsClient extends Server {
  public socket: WebSocket
  private _listeners: Record<number, (response: CQResponse) => void> = {}

  constructor (app: App) {
    super(app)

    this.socket = new WebSocket(app.options.wsServer, {
      headers: {
        Authorization: `Bearer ${app.options.token}`,
      },
    })
  }

  send (data: any): Promise<CQResponse> {
    data.echo = ++counter
    return new Promise((resolve, reject) => {
      this._listeners[counter] = resolve
      this.socket.send(JSON.stringify(data), (error) => {
        if (error) reject(error)
      })
    })
  }

  _listen (): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject)

      this.socket.once('open', () => {
        this.socket.send(JSON.stringify({
          action: 'get_version_info',
          echo: -1,
        }), (error) => {
          if (error) reject(error)
        })

        let resolved = false
        this.socket.on('message', (data) => {
          data = data.toString()
          let parsed: any
          try {
            parsed = JSON.parse(data)
          } catch (error) {
            throw new Error(data)
          }
          if (!resolved) {
            resolved = true
            const { wsServer } = this.apps[0].options
            showServerLog('connect to ws server:', wsServer)
            resolve()
          }
          if ('post_type' in parsed) {
            this._handleData(parsed)
          } else {
            if (parsed.echo === -1) {
              this.version = camelCase(parsed.data)
            }
            if (parsed.echo in this._listeners) {
              this._listeners[parsed.echo](parsed)
            }
          }
        })
      })
    })
  }

  close () {
    if (this.socket) this.socket.close()
    showServerLog('ws client closed')
  }
}

export type ServerType = 'http' | 'ws' // 'ws-reverse'

const serverTypes: Record<ServerType, [keyof AppOptions, Record<keyof any, Server>, new (app: App) => Server]> = {
  http: ['port', {}, HttpServer],
  ws: ['wsServer', {}, WsClient],
}

export function createServer (app: App) {
  const { type } = app.options
  if (!type) {
    throw new Error('missing configuration "type"')
  }
  if (!serverTypes[type]) {
    throw new Error(`server type "${type}" is not supported`)
  }
  const [key, serverMap, Server] = serverTypes[type]
  const value = app.options[key] as any
  if (!value) {
    throw new Error(`missing configuration "${key}"`)
  }
  if (value in serverMap) {
    return serverMap[value].bind(app)
  }
  return serverMap[value] = new Server(app)
}
