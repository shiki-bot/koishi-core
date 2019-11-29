import { SERVER_PORT, CLIENT_PORT, createServer, post } from './utils'
import { createApp, App } from '../src'
import { Server } from 'http'

let app: App
let server: Server

jest.setTimeout(1000)

beforeAll(() => {
  server = createServer(SERVER_PORT)

  app = createApp({
    port: CLIENT_PORT,
    name: 'koishi',
    sendURL: `http://localhost:${SERVER_PORT}`,
    selfId: 514,
  })

  app.start()
})

afterAll(() => {
  server.close()
  app.close()
})

describe('receiver', () => {
  const mocks: jest.Mock[] = []
  for (let index = 0; index < 11; ++index) {
    mocks.push(jest.fn())
  }

  beforeAll(() => {
    app.receiver.on('message', mocks[0])
    app.receiver.on('message/friend', mocks[1])
    app.receiver.on('message/normal', mocks[2])
    app.users.receiver.on('message', mocks[3])
    app.users.receiver.on('message/friend', mocks[4])
    app.user(10000).receiver.on('message', mocks[5])
    app.user(10000).receiver.on('message/friend', mocks[6])
    app.groups.receiver.on('message', mocks[7])
    app.groups.receiver.on('message/normal', mocks[8])
    app.group(10000).receiver.on('message', mocks[9])
    app.group(10000).receiver.on('message/normal', mocks[10])
  })

  test('friend', async () => {
    await post({
      postType: 'message',
      userId: 10000,
      messageType: 'private',
      subType: 'friend',
      message: 'Hello',
    })
  
    mocks.slice(0, 2).forEach(func => expect(func).toBeCalledTimes(1))
    mocks.slice(2, 3).forEach(func => expect(func).toBeCalledTimes(0))
    mocks.slice(3, 7).forEach(func => expect(func).toBeCalledTimes(1))
    mocks.slice(7, 11).forEach(func => expect(func).toBeCalledTimes(0))
  })

  test('group', async () => {
    await post({
      postType: 'message',
      groupId: 10000,
      messageType: 'group',
      subType: 'normal',
      message: 'World',
    })
  
    mocks.slice(0, 1).forEach(func => expect(func).toBeCalledTimes(2))
    mocks.slice(1, 3).forEach(func => expect(func).toBeCalledTimes(1))
    mocks.slice(3, 11).forEach(func => expect(func).toBeCalledTimes(1))
  })
})
