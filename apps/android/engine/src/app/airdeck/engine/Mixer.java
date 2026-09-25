// Mischpult der Handy-Engine: Mikrofon + Musik (mit Ducking), weiche Übergänge, Pegel je Kanal.
package app.airdeck.engine;

public final class Mixer {
    public static final int RATE = 44100;
    public static final int CHANNELS = 2;

    /** Mikrofon: höchstens 0,3 s Vorlauf – lieber verwerfen als verzögern */
    public final PcmRing mic = new PcmRing(RATE * CHANNELS * 3 / 10);
    /** Musik: Decoder füllt bis zu 4 s vor */
    public final PcmRing music = new PcmRing(RATE * CHANNELS * 4);

    private volatile boolean micOn;
    private volatile float micGain = 1f;
    private volatile float musicGain = 1f;
    /** Musik unter dem Mikrofon (Ducking), Standard −10 dB */
    private volatile float duckGain = dbToGain(-10);

    private float curMic;
    private float curDuck = 1f;
    private short[] micBuf = new short[0];
    private short[] musicBuf = new short[0];

    // Pegel (werden vom Mischthread geschrieben, von der Oberfläche gelesen)
    private volatile float micDb = -90;
    private volatile float musicDb = -90;
    private volatile float masterDb = -90;
    private volatile float peakDb = -90;

    public static float dbToGain(double db) {
        return (float) Math.pow(10, db / 20);
    }

    public void setMic(boolean on) { micOn = on; }
    public boolean isMicOn() { return micOn; }
    public void setMicGainDb(double db) { micGain = dbToGain(Math.max(-30, Math.min(20, db))); }
    public void setMusicGainDb(double db) { musicGain = dbToGain(Math.max(-60, Math.min(12, db))); }
    public void setDuckDb(double db) { duckGain = dbToGain(Math.max(-40, Math.min(0, db))); }

    public float micDb() { return micDb; }
    public float musicDb() { return musicDb; }
    public float masterDb() { return masterDb; }
    public float peakDb() { return peakDb; }

    /** frames Frames Stereo in out mischen (out wird überschrieben). */
    public void mix(short[] out, int frames) {
        int n = frames * CHANNELS;
        if (micBuf.length < n) {
            micBuf = new short[n];
            musicBuf = new short[n];
        }
        java.util.Arrays.fill(micBuf, 0, n, (short) 0);
        java.util.Arrays.fill(musicBuf, 0, n, (short) 0);
        mic.read(micBuf, 0, n);
        music.read(musicBuf, 0, n);

        // Rampen über ca. 80 ms (Mikro) bzw. 150 ms (Ducking) – kein Knacken beim Umschalten
        float micTarget = micOn ? micGain : 0f;
        float duckTarget = micOn ? duckGain : 1f;
        float micStep = 1f / (RATE * 0.08f);
        float duckStep = 1f / (RATE * 0.15f);
        double sMic = 0, sMusic = 0, sOut = 0;
        int peak = 0;
        for (int f = 0; f < frames; f++) {
            curMic += clampStep(micTarget - curMic, micStep);
            curDuck += clampStep(duckTarget - curDuck, duckStep);
            float gMusic = musicGain * curDuck;
            for (int c = 0; c < CHANNELS; c++) {
                int i = f * CHANNELS + c;
                float m = micBuf[i] * curMic;
                float b = musicBuf[i] * gMusic;
                int v = Math.round(m + b);
                if (v > Short.MAX_VALUE) v = Short.MAX_VALUE;
                else if (v < Short.MIN_VALUE) v = Short.MIN_VALUE;
                out[i] = (short) v;
                sMic += m * m;
                sMusic += b * b;
                sOut += (double) v * v;
                int a = Math.abs(v);
                if (a > peak) peak = a;
            }
        }
        micDb = toDb(Math.sqrt(sMic / n));
        musicDb = toDb(Math.sqrt(sMusic / n));
        masterDb = toDb(Math.sqrt(sOut / n));
        peakDb = toDb(peak);
    }

    private static float clampStep(float diff, float step) {
        return diff > step ? step : diff < -step ? -step : diff;
    }

    static float toDb(double amp) {
        if (amp <= 0) return -90;
        return (float) Math.max(-90, 20 * Math.log10(amp / 32768.0));
    }
}
