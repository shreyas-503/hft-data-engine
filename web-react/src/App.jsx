import React, { useEffect, useRef } from 'react';

export default function App() {
    const canvasRef = useRef(null);
    const dataRef = useRef({ candles: [], sma: [], bb_u: [], bb_l: [], rsi: [] });
    
    const viewRef = useRef({ 
        offset: 0, zoom: 1, 
        isDragging: false, lastX: 0, 
        mouseX: -1, mouseY: -1 
    });

    useEffect(() => {
        let transport;
        let reader;
        let isRunning = true;

        const connectWebTransport = async () => {
            try {
                console.log("Attempting WebTransport connection to https://127.0.0.1:8080/wt ...");
                
                // --- WEBTRANSPORT (HTTP/3 QUIC) CONNECTION ---

                const certHash = new Uint8Array([170, 55, 121, 158, 216, 205, 31, 158, 140, 210, 76, 40, 159, 210, 128, 239, 132, 7, 50, 125, 10, 191, 245, 53, 198, 178, 119, 203, 129, 84, 126, 3]);
                transport = new WebTransport("https://127.0.0.1:8080/wt", {
                    serverCertificateHashes: [
                        {
                            algorithm: "sha-256",
                            value: certHash
                        }
                    ]
                });
                await transport.ready;
                console.log("✅ WebTransport Connected Successfully!");
                
                reader = transport.datagrams.readable.getReader();

                while (isRunning) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    // WebTransport gives us a raw Uint8Array. We map it directly to a DataView.
                    const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
                    
                    const o = dv.getFloat64(0, true);
                    const h = dv.getFloat64(8, true);
                    const l = dv.getFloat64(16, true);
                    const c = dv.getFloat64(24, true);
                    const sma = dv.getFloat64(32, true);
                    const rsi = dv.getFloat64(40, true);
                    const bb_u = dv.getFloat64(48, true);
                    const bb_l = dv.getFloat64(56, true);

                    const data = dataRef.current;
                    data.candles.push({o, h, l, c});
                    data.sma.push(sma);
                    data.rsi.push(rsi);
                    data.bb_u.push(bb_u);
                    data.bb_l.push(bb_l);

                    if (data.candles.length > 500) {
                        data.candles.shift(); data.sma.shift(); 
                        data.rsi.shift(); data.bb_u.shift(); data.bb_l.shift();
                    }
                    draw();
                }
            } catch (err) {
                console.error("❌ WebTransport Error. Did you enable the Chrome localhost flag?", err);
            }
        };

        connectWebTransport();

        return () => {
            isRunning = false;
            if (reader) reader.cancel();
            if (transport) transport.close();
        };
    }, []);

    const draw = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        
        const width = window.innerWidth;
        const height = window.innerHeight;
        ctx.clearRect(0, 0, width, height);
        
        const data = dataRef.current;
        if (data.candles.length === 0) return;

        const padR = 70, padB = 40;
        const chartW = width - padR, chartH = height - padB;

        const { zoom, offset, mouseX, mouseY } = viewRef.current;
        const visible = Math.floor(100 / zoom);
        const start = Math.max(0, data.candles.length - visible + Math.floor(offset));
        const end = Math.min(data.candles.length, start + visible);
        const slice = data.candles.slice(start, end);

        if(slice.length === 0) return;

        const prices = slice.flatMap(c => [c.h, c.l]);
        
        let min = Math.min(...prices);
        let max = Math.max(...prices);
        const padding = (max - min) * 0.1;
        min -= padding; max += padding;
        
        const scaleY = v => chartH - ((v - min) / (max - min + 1e-9)) * chartH;
        const step = chartW / visible;

        ctx.lineWidth = 1;
        ctx.font = "12px monospace";
        ctx.fillStyle = "#888";
        ctx.strokeStyle = "#222";

        const gridLines = 10;
        for (let i = 0; i <= gridLines; i++) {
            const y = (chartH / gridLines) * i;
            const price = max - ((max - min) / gridLines) * i;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(chartW, y); ctx.stroke();
            ctx.fillText(price.toFixed(2), chartW + 10, y + 4);
        }

        for (let i = 0; i < visible; i += Math.ceil(visible / 10)) {
            const x = i * step; const idx = start + i;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chartH); ctx.stroke();
            ctx.fillText(idx.toString(), x + 5, chartH + 20);
        }

        ctx.lineWidth = 2;
        slice.forEach((c, i) => {
            const x = i * step + step / 2;
            const color = c.c >= c.o ? "#00ff00" : "#ff0000";
            ctx.strokeStyle = color; ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(x, scaleY(c.l)); ctx.lineTo(x, scaleY(c.h)); ctx.stroke();
            const y = scaleY(Math.max(c.o, c.c));
            const h = Math.abs(scaleY(c.o) - scaleY(c.c));
            ctx.fillRect(x - (step * 0.3), y, step * 0.6, h || 1);
        });

        const drawLine = (arr, color) => {
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            slice.forEach((_, i) => {
                const v = arr[start + i]; if (!v) return;
                const x = i * step + step / 2; const y = scaleY(v);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.stroke();
        };

        drawLine(data.sma, "cyan"); drawLine(data.bb_u, "yellow"); drawLine(data.bb_l, "orange");

        if (mouseX >= 0 && mouseX <= chartW && mouseY >= 0 && mouseY <= chartH) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.4)"; ctx.setLineDash([5, 5]);
            ctx.beginPath(); ctx.moveTo(mouseX, 0); ctx.lineTo(mouseX, chartH);
            ctx.moveTo(0, mouseY); ctx.lineTo(chartW, mouseY); ctx.stroke(); ctx.setLineDash([]); 

            const hoveredPrice = max - (mouseY / chartH) * (max - min);
            ctx.fillStyle = "white"; ctx.fillRect(chartW, mouseY - 10, padR, 20);
            ctx.fillStyle = "black"; ctx.fillText(hoveredPrice.toFixed(2), chartW + 5, mouseY + 4);

            const hoveredIdx = Math.floor(mouseX / step);
            if (hoveredIdx >= 0 && hoveredIdx < slice.length) {
                const c = slice[hoveredIdx]; const s = data.sma[start + hoveredIdx]; const r = data.rsi[start + hoveredIdx];
                ctx.fillStyle = "white"; ctx.font = "14px monospace";
                ctx.fillText(`O:${c.o.toFixed(2)} H:${c.h.toFixed(2)} L:${c.l.toFixed(2)} C:${c.c.toFixed(2)} | SMA:${s?.toFixed(2)} | RSI:${r?.toFixed(2)}`, 10, 25);
            }
        }

        ctx.fillStyle = "cyan"; ctx.fillText("■ SMA", 10, 50);
        ctx.fillStyle = "yellow"; ctx.fillText("■ BB Upper", 80, 50);
        ctx.fillStyle = "orange"; ctx.fillText("■ BB Lower", 170, 50);
    };

    useEffect(() => {
        const handleResize = () => draw();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const handleWheel = (e) => {
        viewRef.current.zoom *= (e.deltaY > 0) ? 1.1 : 0.9;
        viewRef.current.zoom = Math.max(0.5, Math.min(viewRef.current.zoom, 10)); draw();
    };
    const handleMouseDown = (e) => { viewRef.current.isDragging = true; viewRef.current.lastX = e.clientX; };
    const handleMouseUp = () => viewRef.current.isDragging = false;
    const handleMouseMove = (e) => {
        viewRef.current.mouseX = e.clientX; viewRef.current.mouseY = e.clientY;
        if (viewRef.current.isDragging) {
            viewRef.current.offset += (e.clientX - viewRef.current.lastX) * 0.5;
            viewRef.current.lastX = e.clientX;
        }
        draw();
    };
    const handleDoubleClick = () => { viewRef.current.offset = 0; viewRef.current.zoom = 1; draw(); };

    return (
        <canvas 
            ref={canvasRef} width={window.innerWidth} height={window.innerHeight} 
            style={{ display: "block", cursor: "crosshair", background: "#0a0a0a" }} 
            onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
            onMouseLeave={() => { viewRef.current.mouseX = -1; handleMouseUp(); }}
            onMouseMove={handleMouseMove} onDoubleClick={handleDoubleClick}
        />
    );
}