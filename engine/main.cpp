#include <winsock2.h>
#include <windows.h>
#include <atomic>
#include <thread>
#include <chrono>
#include <cmath>
#include <random>
#include <vector>
#include <mutex>
#include <iostream>
#include <algorithm>
#include <cstring>

#pragma comment(lib, "ws2_32.lib")

constexpr size_t QSIZE = 1<<12;

struct Tick { double price; uint64_t ts; };

struct Candle {
    double o, h, l, c;
    double volume;
    double vwap;
    uint64_t ts;
};

#pragma pack(push, 1)
struct NetPacket {
    double o, h, l, c;
    double sma, rsi, bb_u, bb_l;
};
#pragma pack(pop)

template<typename T>
struct SPSC {
    T buf[QSIZE];
    std::atomic<uint64_t> w{0}, r{0};

    bool push(const T& v){
        auto wi = w.load(std::memory_order_relaxed); 
        auto ri = r.load(std::memory_order_acquire);
        if(wi - ri >= QSIZE) return false;
        buf[wi % QSIZE] = v;
        w.store(wi + 1, std::memory_order_release);
        return true;
    }

    bool pop(T& v){
        auto ri = r.load(std::memory_order_relaxed); 
        auto wi = w.load(std::memory_order_acquire);
        if(ri >= wi) return false;
        v = buf[ri % QSIZE];
        r.store(ri + 1, std::memory_order_release);
        return true;
    }
};

SPSC<Tick> tick_q;
SPSC<Candle> candle_q;

std::mutex state_mtx;
NetPacket global_state{};

SOCKET sock;
sockaddr_in server;

void init_udp(){
    WSADATA wsa;
    WSAStartup(MAKEWORD(2,2), &wsa);
    sock = socket(AF_INET, SOCK_DGRAM, 0);
    server.sin_family = AF_INET;
    server.sin_port = htons(9999);
    server.sin_addr.s_addr = inet_addr("127.0.0.1");
}

HANDLE hMapFile;
char* pBuf;

constexpr size_t MAX_MMAP = 1024;
constexpr size_t CS = 56;
constexpr size_t IS = 32;
constexpr size_t C1 = 8;
constexpr size_t C5 = C1 + MAX_MMAP * CS;
constexpr size_t IND = C5 + MAX_MMAP * CS;
constexpr size_t SIZE_MMAP = IND + MAX_MMAP * IS;

void init_mmap() {
    hMapFile = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, SIZE_MMAP, "Local\\StockBuffer");
    if (hMapFile == NULL) {
        std::cerr << "Failed to create file mapping object.\n";
        return;
    }
    pBuf = (char*) MapViewOfFile(hMapFile, FILE_MAP_ALL_ACCESS, 0, 0, SIZE_MMAP);
    if (pBuf == NULL) {
        std::cerr << "Failed to map view of file.\n";
        CloseHandle(hMapFile);
    }
}

void write_mmap(uint64_t idx, const Candle& c, double sma, double rsi, double bu, double bl) {
    if (!pBuf) return;
    
    memcpy(pBuf, &idx, 8);
    size_t mmap_idx = idx % MAX_MMAP;
    
    size_t c_offset = C1 + mmap_idx * CS;
    double c_data[6] = {c.o, c.h, c.l, c.c, c.volume, c.vwap};
    memcpy(pBuf + c_offset, c_data, 48);
    memcpy(pBuf + c_offset + 48, &c.ts, 8);
    
    size_t c5_offset = C5 + mmap_idx * CS;
    memcpy(pBuf + c5_offset, c_data, 48);
    memcpy(pBuf + c5_offset + 48, &c.ts, 8);

    size_t ind_offset = IND + mmap_idx * IS;
    double ind_data[4] = {sma, rsi, bu, bl};
    memcpy(pBuf + ind_offset, ind_data, 32);
}

uint64_t now_ns(){
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void producer(){
    double S = 1000;
    std::mt19937 rng(std::random_device{}());
    std::normal_distribution<> Z(0,1);

    while(true){
        S *= exp(0.0001 + 0.01 * Z(rng));
        tick_q.push({S, now_ns()});
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void candle_builder(){
    uint64_t last = 0;
    Candle cur{};
    double vol = 0, pv = 0;

    while(true){
        Tick t;
        while(tick_q.pop(t)){
            uint64_t sec = t.ts / 1'000'000'000;

            if(!last){
                last = sec;
                cur = {t.price, t.price, t.price, t.price, 0, 0, sec};
                vol = 1; pv = t.price;
                continue;
            }

            if(sec == last){
                cur.h = std::max(cur.h, t.price);
                cur.l = std::min(cur.l, t.price);
                cur.c = t.price;
                vol++; pv += t.price;
            } else {
                cur.volume = vol;
                cur.vwap = pv / vol;
                candle_q.push(cur);

                last = sec;
                cur = {t.price, t.price, t.price, t.price, 0, 0, sec};
                vol = 1; pv = t.price;
            }
        }
        std::this_thread::yield();
    }
}

void analytics(){
    init_mmap();
    
    std::vector<double> closes;
    std::vector<double> gains;
    std::vector<double> losses;
    
    double sum = 0, sum_sq = 0;
    double gain_sum = 0, loss_sum = 0;
    uint64_t mmap_idx = 0;

    while(true){
        Candle c;
        while(candle_q.pop(c)){
            double diff = closes.empty() ? 0 : c.c - closes.back();
            double g = diff > 0 ? diff : 0;
            double l_val = diff < 0 ? -diff : 0;
            
            closes.push_back(c.c);
            gains.push_back(g);
            losses.push_back(l_val);
            
            sum += c.c;
            sum_sq += c.c * c.c;
            gain_sum += g;
            loss_sum += l_val;

            if(closes.size() > 20){
                double old_c = closes[closes.size() - 21];
                sum -= old_c;
                sum_sq -= old_c * old_c;
            }
            if(gains.size() > 14) {
                double old_g = gains[gains.size() - 15];
                double old_l = losses[losses.size() - 15];
                gain_sum -= old_g;
                loss_sum -= old_l;
            }

            if(closes.size() >= 20){
                double sma = sum / 20;
                double var = (sum_sq / 20) - (sma * sma);
                double stddev = sqrt(std::max(0.0, var));
                
                double rs = (loss_sum == 0) ? 100 : (gain_sum / loss_sum);
                double rsi = (loss_sum == 0) ? 100 : 100 - (100 / (1 + rs));

                double bu = sma + 2 * stddev;
                double bl = sma - 2 * stddev;

                {
                    std::lock_guard<std::mutex> lock(state_mtx);
                    global_state = {c.o, c.h, c.l, c.c, sma, rsi, bu, bl};
                }

                mmap_idx++;
                write_mmap(mmap_idx, c, sma, rsi, bu, bl);
            }
        }
        std::this_thread::yield();
    }
}
void publisher(){
    init_udp();
    NetPacket current;
    NetPacket last_sent{};

    const auto interval = std::chrono::milliseconds(1);
    
    auto next_tick = std::chrono::steady_clock::now();

    while(true){
        {
            std::lock_guard<std::mutex> lock(state_mtx);
            current = global_state;
        }
        
        if(current.c > 0 && memcmp(&current, &last_sent, sizeof(NetPacket)) != 0) {
            sendto(sock, (const char*)&current, sizeof(NetPacket), 0, (sockaddr*)&server, sizeof(server));
            last_sent = current;
        }
        
        next_tick += interval;
        
        std::this_thread::sleep_until(next_tick);
    }
}

int main(){
    std::thread t1(producer);
    std::thread t2(candle_builder);
    std::thread t3(analytics);
    std::thread t4(publisher);

    t1.join(); 
    t2.join(); 
    t3.join(); 
    t4.join();
    
    return 0;
}
