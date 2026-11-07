import asyncio
import json
import socket
import socketio
import uvicorn

sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins=[])
gate = asyncio.Event()
stats = {'chat_connects': 0, 'chat_disconnects': 0, 'tool_connects': 0, 'registrations': 0}

@sio.on('connect', namespace='/chat')
async def chat_connect(sid, environ, auth):
    stats['chat_connects'] += 1
    return True

@sio.on('disconnect', namespace='/chat')
async def chat_disconnect(sid, *args):
    stats['chat_disconnects'] += 1

@sio.on('join_conversation', namespace='/chat')
async def join(sid, data):
    return {'accepted': True, 'recoveryComplete': True}

@sio.on('connect', namespace='/remote-tool')
async def tool_connect(sid, environ, auth):
    stats['tool_connects'] += 1
    await gate.wait()
    return True

@sio.on('register', namespace='/remote-tool')
async def register(sid, data):
    stats['registrations'] += 1
    return {'providerId': sid, 'registeredToolNames': [t['toolName'] for t in data['tools']], 'error': None}

@sio.on('revoke', namespace='/remote-tool')
async def revoke(sid, data):
    return {'providerId': sid, 'revokedToolNames': ['host_tool'], 'error': None}

async def http(scope, receive, send):
    if scope['type'] != 'http':
        return
    path = scope['path']
    if path == '/release':
        gate.set()
        result = {'ok': True}
    elif path == '/stats':
        result = dict(stats, engines=len(sio.eio.sockets))
    else:
        data = {'working': False, 'taskId': None} if path.endswith('/status') else {'messages': [], 'events': [], 'cursor': None} if path.endswith('/messages') else {'conversations': [{'conversationId': '1', 'title': 'Python probe', 'description': None, 'updateTimestamp': 1800000000000}], 'cursor': None}
        result = {'code': 200, 'message': 'Success', 'data': data}
    await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-type', b'application/json')]})
    await send({'type': 'http.response.body', 'body': json.dumps(result).encode()})

async def main():
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    config = uvicorn.Config(socketio.ASGIApp(sio, http), log_level='error', lifespan='off')
    server = uvicorn.Server(config)
    print(listener.getsockname()[1], flush=True)
    await server.serve(sockets=[listener])

asyncio.run(main())
