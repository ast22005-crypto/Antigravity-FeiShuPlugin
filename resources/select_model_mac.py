#!/usr/bin/env python3
import sys
import ctypes
import ctypes.util
import subprocess
import time

cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
ax = ctypes.cdll.LoadLibrary(ctypes.util.find_library("ApplicationServices"))

CFTypeRef = ctypes.c_void_p
CFStringRef = ctypes.c_void_p
CFIndex = ctypes.c_long
kCFStringEncodingUTF8 = 0x08000100

cf.CFRelease.argtypes = [CFTypeRef]
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetCount.restype = CFIndex
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, CFIndex]
cf.CFArrayGetValueAtIndex.restype = CFTypeRef
cf.CFStringCreateWithCString.argtypes = [CFTypeRef, ctypes.c_char_p, ctypes.c_uint32]
cf.CFStringCreateWithCString.restype = CFStringRef
cf.CFStringGetCStringPtr.argtypes = [CFStringRef, ctypes.c_uint32]
cf.CFStringGetCStringPtr.restype = ctypes.c_char_p
cf.CFStringGetCString.argtypes = [CFStringRef, ctypes.c_char_p, CFIndex, ctypes.c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFGetTypeID.argtypes = [CFTypeRef]; cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFStringGetTypeID.argtypes = []; cf.CFStringGetTypeID.restype = ctypes.c_ulong

ax.AXUIElementCreateApplication.argtypes = [ctypes.c_int32]
ax.AXUIElementCreateApplication.restype = CFTypeRef
ax.AXUIElementCopyAttributeValue.argtypes = [CFTypeRef, CFStringRef, ctypes.POINTER(CFTypeRef)]
ax.AXUIElementSetAttributeValue.argtypes = [CFTypeRef, CFStringRef, CFTypeRef]
ax.AXUIElementPerformAction.argtypes = [CFTypeRef, CFStringRef]

kCFBooleanTrue = CFTypeRef.in_dll(cf, "kCFBooleanTrue")

def cfstr(s): return cf.CFStringCreateWithCString(None, s.encode("utf-8"), kCFStringEncodingUTF8)
def pystr(cfs):
    if not cfs: return ""
    p = cf.CFStringGetCStringPtr(cfs, kCFStringEncodingUTF8)
    if p: return p.decode("utf-8")
    b = ctypes.create_string_buffer(4096)
    if cf.CFStringGetCString(cfs, b, 4096, kCFStringEncodingUTF8): return b.value.decode("utf-8")
    return ""

def get_str(elem, attr_name):
    a = cfstr(attr_name); v = CFTypeRef()
    if ax.AXUIElementCopyAttributeValue(elem, a, ctypes.byref(v)) == 0 and v.value:
        try:
            if cf.CFGetTypeID(v) == cf.CFStringGetTypeID():
                res = pystr(v); cf.CFRelease(v); cf.CFRelease(a); return res
        except: pass
        try: cf.CFRelease(v)
        except: pass
    cf.CFRelease(a)
    return ""

def get_children(elem):
    a = cfstr("AXChildren"); v = CFTypeRef()
    err = ax.AXUIElementCopyAttributeValue(elem, a, ctypes.byref(v))
    cf.CFRelease(a)
    if err != 0 or not v.value: return []
    return [cf.CFArrayGetValueAtIndex(v, i) for i in range(cf.CFArrayGetCount(v))]

def press(elem):
    a = cfstr("AXPress"); err = ax.AXUIElementPerformAction(elem, a); cf.CFRelease(a)
    return err == 0

def find_target_item(elem, target_text, depth=0, max_depth=15):
    if depth > max_depth: return None
    role = get_str(elem, "AXRole")
    text = (get_str(elem, "AXTitle") or get_str(elem, "AXValue") or "").strip()
    # Accept if the target string is exact match or heavily contained in the element text
    if text and (target_text.lower() == text.lower() or target_text.lower() in text.lower()):
        return elem
    for child in get_children(elem):
        if child:
            found = find_target_item(child, target_text, depth + 1, max_depth)
            if found: return found
    return None

def find_pid():
    try:
        r = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True)
        for line in r.stdout.strip().split("\n"):
            if "Antigravity.app/Contents/MacOS/Electron" in line and "Helper" not in line and "grep" not in line:
                return int(line.strip().split()[0])
    except: pass
    return None

def main():
    if len(sys.argv) < 2: return
    target_model = sys.argv[1].strip()
    pid = find_pid()
    if not pid: print("PID_NOT_FOUND"); return
    app = ax.AXUIElementCreateApplication(pid)
    # Give the UI a moment to open
    time.sleep(1)
    a = cfstr("AXManualAccessibility"); ax.AXUIElementSetAttributeValue(app, a, kCFBooleanTrue); cf.CFRelease(a)
    wa = cfstr("AXWindows"); wv = CFTypeRef()
    if ax.AXUIElementCopyAttributeValue(app, wa, ctypes.byref(wv)) != 0 or not wv.value:
        print("NO_WINDOWS"); return
    for i in range(cf.CFArrayGetCount(wv)):
        win = cf.CFArrayGetValueAtIndex(wv, i)
        if win:
            target = find_target_item(win, target_model)
            if target:
                if press(target):
                    # Also press enter just in case it focuses instead of clicks
                    import os
                    os.system("osascript -e 'tell application \"System Events\" to key code 36'")
                    print("SUCCESS")
                    return
    print("NOT_FOUND")

if __name__ == "__main__": main()
