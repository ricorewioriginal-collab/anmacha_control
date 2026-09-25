// Einfache Abtastraten- und Kanalwandlung (linear) auf 44,1 kHz Stereo – für Titel vom Handy (oft 48 kHz).
package app.airdeck.engine;

public final class Resampler {
    private final int inRate;
    private final int inChannels;
    private final int outRate;
    private double pos;
    private short lastL;
    private short lastR;
    private boolean primed;

    public Resampler(int inRate, int inChannels, int outRate) {
        if (inRate <= 0 || inChannels <= 0) throw new IllegalArgumentException("Ungültiges Eingangsformat");
        this.inRate = inRate;
        this.inChannels = inChannels;
        this.outRate = outRate;
    }

    /** Größe des Ausgabepuffers (Samples) für inFrames Eingangs-Frames. */
    public int maxOut(int inFrames) {
        return ((int) Math.ceil((double) inFrames * outRate / inRate) + 2) * 2;
    }

    /**
     * Wandelt inFrames Frames (verschachtelt, inChannels Kanäle) nach Stereo/outRate.
     * @return Anzahl geschriebener Samples in out (Frames × 2)
     */
    public int process(short[] in, int inFrames, short[] out) {
        int o = 0;
        if (inFrames <= 0) return 0;
        if (inRate == outRate) {
            for (int i = 0; i < inFrames; i++) {
                out[o++] = left(in, i);
                out[o++] = right(in, i);
            }
            return o;
        }
        double step = (double) inRate / outRate;
        if (!primed) {
            lastL = left(in, 0);
            lastR = right(in, 0);
            primed = true;
        }
        // pos: Position relativ zum Frame vor diesem Block (-1 = letzter Frame des vorigen Blocks)
        while (true) {
            int i = (int) Math.floor(pos);
            if (i + 1 >= inFrames) break;
            double f = pos - i;
            short l0 = i < 0 ? lastL : left(in, i);
            short r0 = i < 0 ? lastR : right(in, i);
            out[o++] = (short) Math.round(l0 + (left(in, i + 1) - l0) * f);
            out[o++] = (short) Math.round(r0 + (right(in, i + 1) - r0) * f);
            pos += step;
        }
        lastL = left(in, inFrames - 1);
        lastR = right(in, inFrames - 1);
        pos -= inFrames;
        return o;
    }

    private short left(short[] in, int frame) {
        return in[frame * inChannels];
    }

    private short right(short[] in, int frame) {
        return inChannels == 1 ? in[frame] : in[frame * inChannels + 1];
    }
}
