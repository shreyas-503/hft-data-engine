import dgram from 'node:dgram';
import fs from 'node:fs';
import { Http3Server } from '@fails-components/webtransport';

// 1. Setup the HTTP/3 WebTransport Server
const wtServer = new Http3Server({
  port: 8080,
  host: '127.0.0.1',
  secret: 'my_super_secret_string', 
  cert: fs.readFileSync('./cert.pem'),
  privKey: fs.readFileSync('./key.pem')
});

const clients = new Set();

// 2. Listen for WebTransport sessions on the "/wt" endpoint
(async () => {
    const stream = await wtServer.sessionStream("/wt");
    const sessionReader = stream.getReader();
    
    while (true) {
        const { done, value: session } = await sessionReader.read();
        if (done) break;
        
        clients.add(session);
        console.log("React Client connected via QUIC (WebTransport)");

        // Remove client when they disconnect
        session.closed
            .then(() => clients.delete(session))
            .catch(() => clients.delete(session));
    }
})();

wtServer.startServer();
console.log("WebTransport (HTTP/3) Server running on https://127.0.0.1:8080/wt");

// 3. Setup the UDP Listener from C++
const udp = dgram.createSocket('udp4');

udp.on('message', (msg) => {
    // 4. Forward the binary payload over WebTransport Datagrams (UDP -> QUIC)
    clients.forEach(async (session) => {
        try {
            const writer = session.datagrams.writable.getWriter();
            await writer.write(msg); // Send the raw bytes
            writer.releaseLock();
        } catch (e) {
            clients.delete(session);
        }
    });
});

udp.bind(9999, () => {
    console.log("C++ UDP pipeline listening on port 9999");
});