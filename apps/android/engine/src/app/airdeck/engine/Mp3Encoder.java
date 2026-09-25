// MP3-Encoder (LAME, reine Java-Portierung „jump3r“ – läuft auf Android ohne native Bibliotheken).
package app.airdeck.engine;

import de.sciss.jump3r.mp3.BitStream;
import de.sciss.jump3r.mp3.GainAnalysis;
import de.sciss.jump3r.mp3.GetAudio;
import de.sciss.jump3r.mp3.ID3Tag;
import de.sciss.jump3r.mp3.Lame;
import de.sciss.jump3r.mp3.LameGlobalFlags;
import de.sciss.jump3r.mp3.MPEGMode;
import de.sciss.jump3r.mp3.Parse;
import de.sciss.jump3r.mp3.Presets;
import de.sciss.jump3r.mp3.Quantize;
import de.sciss.jump3r.mp3.QuantizePVT;
import de.sciss.jump3r.mp3.Reservoir;
import de.sciss.jump3r.mp3.Takehiro;
import de.sciss.jump3r.mp3.VBRTag;
import de.sciss.jump3r.mp3.Version;
import de.sciss.jump3r.mpg.Common;
import de.sciss.jump3r.mpg.Interface;
import de.sciss.jump3r.mpg.MPGLib;

/** Stereo, 16 Bit, konstante Bitrate (CBR) – wie ein Stream-Encoder es braucht. */
public final class Mp3Encoder {
    private final Lame lame = new Lame();
    private final LameGlobalFlags gfp;
    private int[] left = new int[0];
    private int[] right = new int[0];
    private byte[] out = new byte[0];

    /** @param quality 0 (beste) … 9 (schnellste); für Live auf dem Handy ist 5 ein guter Kompromiss */
    public Mp3Encoder(int sampleRate, int bitrateKbps, int quality) {
        GetAudio gaud = new GetAudio();
        GainAnalysis ga = new GainAnalysis();
        BitStream bs = new BitStream();
        Presets p = new Presets();
        QuantizePVT qupvt = new QuantizePVT();
        Quantize qu = new Quantize();
        VBRTag vbr = new VBRTag();
        Version ver = new Version();
        ID3Tag id3 = new ID3Tag();
        Reservoir rv = new Reservoir();
        Takehiro tak = new Takehiro();
        Parse parse = new Parse();
        MPGLib mpg = new MPGLib();
        Interface intf = new Interface();
        Common common = new Common();

        lame.setModules(ga, bs, p, qupvt, qu, vbr, ver, id3, mpg);
        bs.setModules(ga, mpg, ver, vbr);
        id3.setModules(bs, ver);
        p.setModules(lame);
        qu.setModules(bs, rv, qupvt, tak);
        qupvt.setModules(tak, rv, lame.enc.psy);
        rv.setModules(bs);
        tak.setModules(qupvt);
        vbr.setModules(lame, bs, ver);
        gaud.setModules(parse, mpg);
        parse.setModules(ver, id3, p);
        mpg.setModules(intf, common);
        intf.setModules(vbr, common);

        gfp = lame.lame_init();
        gfp.num_channels = 2;
        gfp.in_samplerate = sampleRate;
        gfp.out_samplerate = sampleRate;
        gfp.mode = MPEGMode.JOINT_STEREO;
        gfp.brate = bitrateKbps;
        gfp.quality = Math.max(0, Math.min(9, quality));
        gfp.bWriteVbrTag = false;
        id3.id3tag_init(gfp);
        gfp.write_id3tag_automatic = false;
        gfp.findReplayGain = false;
        if (lame.lame_init_params(gfp) < 0) throw new IllegalArgumentException("MP3-Encoder: Einstellungen nicht unterstützt (" + sampleRate + " Hz, " + bitrateKbps + " kbit/s)");
    }

    /** Stereo-PCM (verschachtelt L,R,L,R …) kodieren; liefert die fertigen MP3-Bytes (kann leer sein). */
    public byte[] encode(short[] interleaved, int frames) {
        if (left.length < frames) {
            left = new int[frames];
            right = new int[frames];
        }
        for (int i = 0; i < frames; i++) {
            left[i] = interleaved[2 * i] << 16;
            right[i] = interleaved[2 * i + 1] << 16;
        }
        int need = (int) (1.25 * frames) + 7200;
        if (out.length < need) out = new byte[need];
        int n = lame.lame_encode_buffer_int(gfp, left, right, frames, out, 0, out.length);
        if (n < 0) throw new IllegalStateException("MP3-Encoder: Fehler " + n);
        byte[] r = new byte[n];
        System.arraycopy(out, 0, r, 0, n);
        return r;
    }

    /** Restliche Daten am Ende einer Sendung. */
    public byte[] flush() {
        byte[] buf = new byte[7200];
        int n = lame.lame_encode_flush(gfp, buf, 0, buf.length);
        byte[] r = new byte[Math.max(0, n)];
        System.arraycopy(buf, 0, r, 0, r.length);
        return r;
    }

    public void close() {
        lame.lame_close(gfp);
    }
}
