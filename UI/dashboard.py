import mmap, struct, numpy as np, pyqtgraph as pg
from pyqtgraph.Qt import QtWidgets, QtCore

MAX=1024
CS=56
IS=32

IDX=0
C1=8
C5=C1+MAX*CS
IND=C5+MAX*CS
SIZE=IND+MAX*IS

mm=mmap.mmap(-1, SIZE, tagname="Local\\StockBuffer")
USE_5S=False

def read():
    idx=struct.unpack_from("Q", mm, 0)[0]
    c=[]; c5=[]; ind=[]
    for i in range(min(idx, MAX)):
        o,h,l,cl,v,vw,ts = struct.unpack_from("ddddddQ", mm, C1+i*CS)
        o5,h5,l5,c5_,v5,vw5,ts5 = struct.unpack_from("ddddddQ", mm, C5+i*CS)
        sma,rsi,bu,bl = struct.unpack_from("dddd", mm, IND+i*IS)
        
        c.append((ts,o,h,l,cl))
        c5.append((ts5,o5,h5,l5,c5_))
        ind.append((sma,rsi,bu,bl))
    return c, c5, ind

class Candle(pg.GraphicsObject):
    def __init__(self): 
        super().__init__()
        self.d=[]
    
    def setData(self, d): 
        self.d = d
        self.prepareGeometryChange()
        
    def paint(self, p, *a):
        p.setPen(pg.mkPen((255, 255, 255, 100))) # wick color
        for i, (_, o, h, l, c) in enumerate(self.d):
            col = (0, 255, 0) if c >= o else (255, 0, 0)
            p.setPen(pg.mkPen(col))
            p.setBrush(pg.mkBrush(col))
            
            # Draw wick
            p.drawLine(QtCore.QPointF(i, l), QtCore.QPointF(i, h))
            # Draw body
            p.drawRect(QtCore.QRectF(i - 0.3, min(o, c), 0.6, abs(c - o) or 0.001))
            
    def boundingRect(self):
        if not self.d: return QtCore.QRectF(0, 0, 1, 1)
        lows = [x[3] for x in self.d]
        highs = [x[2] for x in self.d]
        return QtCore.QRectF(0, min(lows), len(self.d), max(highs) - min(lows))

app = QtWidgets.QApplication([])

# Global styling
pg.setConfigOption('background', '#0a0a0a')
pg.setConfigOption('foreground', 'd')

w = pg.GraphicsLayoutWidget(show=True, title="HFT Dashboard")
w.resize(1000, 600)

p = w.addPlot(title="Real-Time Market Data (MMAP IPC)")
p.showGrid(x=True, y=True, alpha=0.3)
p.setLabel('left', 'Stock Price', units='₹')
p.setLabel('bottom', 'Time (Tick Index)')

# Add Interactive Legend
p.addLegend(offset=(10, 10))

# Add items to plot
ci = Candle()
p.addItem(ci)

# Safely handle PyQt5 vs PyQt6 enums
dash_style = QtCore.Qt.PenStyle.DashLine if hasattr(QtCore.Qt, 'PenStyle') else QtCore.Qt.DashLine

# Named plots so they show up in the legend
sma = p.plot(pen=pg.mkPen('c', width=2), name='SMA (20)')
bbu = p.plot(pen=pg.mkPen('y', width=1, style=dash_style), name='BB Upper')
bbl = p.plot(pen=pg.mkPen((255, 165, 0), width=1, style=dash_style), name='BB Lower')

def update():
    c, c5, ind = read()
    data = c5 if USE_5S else c

    if not data: return

    ci.setData(data)
    x = np.arange(len(data))
    
    # Update Indicators
    sma.setData(x, [i[0] for i in ind])
    bbu.setData(x, [i[2] for i in ind])
    bbl.setData(x, [i[3] for i in ind])

    # Auto-scroll view
    p.setXRange(max(0, len(data) - 100), len(data))

t = QtCore.QTimer()
t.timeout.connect(update)
t.start(16)

app.exec()