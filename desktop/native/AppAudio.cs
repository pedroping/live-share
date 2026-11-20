// appaudio.exe - per-application audio capture for Windows 10 2004+ / 11.
//
// Uses WASAPI process loopback (the same OS feature Discord uses to stream a
// single app's sound) to capture either ONE process tree, or EVERYTHING EXCEPT
// one process tree, and writes raw PCM to stdout:
//   48000 Hz, 2 channels, signed 16-bit little-endian, interleaved.
//
// Commands:
//   appaudio capture include <pid>   only that process tree's audio
//   appaudio capture exclude <pid>   all system audio except that tree
//   appaudio windows                 JSON: visible top-level windows
//   appaudio processes               JSON: root processes (for app pickers)
//
// The capture exits when stdin closes, so it never outlives the Electron app.
// Build: csc /platform:x64 /optimize /out:appaudio.exe AppAudio.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class AppAudio
{
    [MTAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length >= 3 && args[0] == "capture")
            {
                bool include = args[1] == "include";
                uint pid = uint.Parse(args[2]);
                return Capture.Run(pid, include);
            }
            if (args.Length >= 1 && args[0] == "windows") { Console.Out.Write(Procs.WindowsJson()); return 0; }
            if (args.Length >= 1 && args[0] == "processes") { Console.Out.Write(Procs.ProcessesJson()); return 0; }
            Console.Error.WriteLine("usage: appaudio capture include|exclude <pid> | windows | processes");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
    }
}

// ---------------------------------------------------------------- capture
static class Capture
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BitsPerSample = 16;
    const int BlockAlign = Channels * BitsPerSample / 8;

    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    public static int Run(uint pid, bool include)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType=PROCESS_LOOPBACK(1), TargetProcessId, ProcessLoopbackMode }
        IntPtr activation = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(activation, 0, 1);
        Marshal.WriteInt32(activation, 4, (int)pid);
        Marshal.WriteInt32(activation, 8, include ? 0 : 1);

        // PROPVARIANT { vt = VT_BLOB(65), blob = { cbSize = 12, pBlobData } } (24 bytes on x64)
        IntPtr propvariant = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i++) Marshal.WriteByte(propvariant, i, 0);
        Marshal.WriteInt16(propvariant, 0, 65);
        Marshal.WriteInt32(propvariant, 8, 12);
        Marshal.WriteIntPtr(propvariant, 16, activation);

        var handler = new CompletionHandler();
        IActivateAudioInterfaceAsyncOperation op;
        ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IID_IAudioClient, propvariant, handler, out op);
        if (!handler.Done.WaitOne(5000)) throw new Exception("audio activation timed out");
        if (handler.Result != 0) throw new Exception("audio activation failed: 0x" + handler.Result.ToString("X8"));
        var client = (IAudioClient)handler.Client;

        // WAVEFORMATEX PCM
        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 1);                                   // wFormatTag = PCM
        Marshal.WriteInt16(format, 2, Channels);                            // nChannels
        Marshal.WriteInt32(format, 4, SampleRate);                          // nSamplesPerSec
        Marshal.WriteInt32(format, 8, SampleRate * BlockAlign);             // nAvgBytesPerSec
        Marshal.WriteInt16(format, 12, BlockAlign);                         // nBlockAlign
        Marshal.WriteInt16(format, 14, BitsPerSample);                      // wBitsPerSample
        Marshal.WriteInt16(format, 16, 0);                                  // cbSize

        client.Initialize(0 /* shared */,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            2000000 /* 200ms in 100ns units */, 0, format, IntPtr.Zero);

        var ready = new AutoResetEvent(false);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        object captureObj;
        Guid iidCapture = IID_IAudioCaptureClient;
        client.GetService(ref iidCapture, out captureObj);
        var capture = (IAudioCaptureClient)captureObj;

        // Exit when the parent closes our stdin.
        var stdinWatcher = new Thread(() =>
        {
            try { var stdin = Console.OpenStandardInput(); var b = new byte[64]; while (stdin.Read(b, 0, b.Length) > 0) { } }
            catch { }
            Environment.Exit(0);
        });
        stdinWatcher.IsBackground = true;
        stdinWatcher.Start();

        Stream stdout = Console.OpenStandardOutput();
        byte[] buffer = new byte[SampleRate * BlockAlign]; // up to 1s per packet
        client.Start();
        Console.Error.WriteLine("capturing " + (include ? "only" : "all except") + " pid " + pid);

        while (true)
        {
            ready.WaitOne(100);
            uint packet;
            capture.GetNextPacketSize(out packet);
            while (packet > 0)
            {
                IntPtr data; uint frames; uint flags; ulong devPos, qpcPos;
                capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                int bytes = (int)frames * BlockAlign;
                if (bytes > buffer.Length) buffer = new byte[bytes];
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buffer, 0, bytes);
                else Marshal.Copy(data, buffer, 0, bytes);
                capture.ReleaseBuffer(frames);
                try { stdout.Write(buffer, 0, bytes); stdout.Flush(); }
                catch (IOException) { return 0; } // parent went away
                capture.GetNextPacketSize(out packet);
            }
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result = -1;
        public object Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                int hr; object iface;
                op.GetActivateResult(out hr, out iface);
                Result = hr;
                Client = iface;
            }
            catch (Exception e) { Result = Marshal.GetHRForException(e); }
            Done.Set();
        }
    }
}

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    void Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
    void GetBufferSize(out uint numBufferFrames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint numPaddingFrames);
    void IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
    void GetMixFormat(out IntPtr deviceFormat);
    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr eventHandle);
    void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    void GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    void ReleaseBuffer(uint numFramesRead);
    void GetNextPacketSize(out uint numFramesInNextPacket);
}

// ---------------------------------------------------------------- processes / windows
static class Procs
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    class P { public uint Pid, Parent; public string Name; }

    static Dictionary<uint, P> Snapshot()
    {
        var map = new Dictionary<uint, P>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        if (Process32FirstW(snap, ref e))
        {
            do { map[e.th32ProcessID] = new P { Pid = e.th32ProcessID, Parent = e.th32ParentProcessID, Name = e.szExeFile }; }
            while (Process32NextW(snap, ref e));
        }
        CloseHandle(snap);
        return map;
    }

    // Walk up while the parent is the same executable (Chrome, Discord, Electron
    // apps spawn many children) so "exclude Discord" covers all of them.
    static uint Root(Dictionary<uint, P> map, uint pid)
    {
        P p;
        if (!map.TryGetValue(pid, out p)) return pid;
        var seen = new HashSet<uint>();
        while (seen.Add(p.Pid))
        {
            P parent;
            if (!map.TryGetValue(p.Parent, out parent)) break;
            if (!string.Equals(parent.Name, p.Name, StringComparison.OrdinalIgnoreCase)) break;
            p = parent;
        }
        return p.Pid;
    }

    static string Esc(string s)
    {
        var b = new StringBuilder();
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
            else b.Append(c);
        }
        return b.ToString();
    }

    public static string WindowsJson()
    {
        var map = Snapshot();
        var items = new List<string>();
        EnumWindows((hwnd, l) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            int len = GetWindowTextLengthW(hwnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowTextW(hwnd, sb, sb.Capacity);
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            P p;
            string name = map.TryGetValue(pid, out p) ? p.Name : "";
            items.Add(string.Format("{{\"hwnd\":{0},\"pid\":{1},\"rootPid\":{2},\"name\":\"{3}\",\"title\":\"{4}\"}}",
                hwnd.ToInt64(), pid, Root(map, pid), Esc(name), Esc(sb.ToString())));
            return true;
        }, IntPtr.Zero);
        return "[" + string.Join(",", items) + "]";
    }

    public static string ProcessesJson()
    {
        var map = Snapshot();
        var windowed = new HashSet<uint>();
        EnumWindows((hwnd, l) =>
        {
            if (IsWindowVisible(hwnd) && GetWindowTextLengthW(hwnd) > 0)
            {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                windowed.Add(Root(map, pid));
            }
            return true;
        }, IntPtr.Zero);

        var roots = new Dictionary<uint, P>();
        foreach (var p in map.Values)
        {
            if (p.Pid == 0 || p.Pid == 4) continue;
            uint r = Root(map, p.Pid);
            if (!roots.ContainsKey(r) && map.ContainsKey(r)) roots[r] = map[r];
        }
        var items = new List<string>();
        foreach (var p in roots.Values)
        {
            items.Add(string.Format("{{\"pid\":{0},\"name\":\"{1}\",\"hasWindow\":{2}}}",
                p.Pid, Esc(p.Name), windowed.Contains(p.Pid) ? "true" : "false"));
        }
        return "[" + string.Join(",", items) + "]";
    }
}
