const { WebSocket } = require('ws');

// Send a JSON message if the socket is still open; otherwise do nothing.
function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

module.exports = { send };
