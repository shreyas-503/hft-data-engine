const dgram = require('dgram');
const WebSocket = require('ws');

const udp = dgram.createSocket('udp4');
const wss = new WebSocket.Server({ port: 8080 });

udp.on('message', (msg) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
});

udp.bind(9999, () => {
    console.log("UDP relay listening on 9999, WebSockets on 8080");
});
