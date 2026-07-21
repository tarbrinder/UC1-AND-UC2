import { useState, useRef, useEffect } from 'react';
import { X, Phone, ShieldCheck, RotateCcw } from 'lucide-react';
import { localDB } from '../lib/supabase';

// Demo OTP — always "1234". Replace with real SMS provider when ready.
const DEMO_OTP = '1234';

interface Props {
  onVerified: (name: string, mobile: string) => void;
  onClose: () => void;
  /** When both are supplied (mobile = 10 digits), skip the name/number step and open straight on the 4-digit OTP. */
  initialName?: string;
  initialMobile?: string;
}

export default function OTPGate({ onVerified, onClose, initialName, initialMobile }: Props) {
  const seedMobile = (initialMobile || '').replace(/\D/g, '').slice(-10);
  const seedName = (initialName || '').trim();
  const preseeded = /^\d{10}$/.test(seedMobile) && seedName.length > 0;
  // Step 1: mobile + name entry
  const [step, setStep] = useState<1 | 2>(preseeded ? 2 : 1);
  const [name, setName] = useState(seedName);
  const [mobile, setMobile] = useState(seedMobile);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [sendError, setSendError] = useState('');

  // Step 2: OTP entry
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const [verifying, setVerifying] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [countdown, setCountdown] = useState(60);
  const [canResend, setCanResend] = useState(false);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([null, null, null, null]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start countdown when entering step 2
  useEffect(() => {
    if (step === 2) {
      setCountdown(60);
      setCanResend(false);
      timerRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            setCanResend(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [step]);

  async function handleSendOtp() {
    setSendError('');
    if (!/^\d{10}$/.test(mobile)) {
      setSendError('Enter a valid 10-digit mobile number.');
      return;
    }
    if (!name.trim()) {
      setSendError('Please enter your name.');
      return;
    }
    setSendingOtp(true);
    // Simulate network delay, then advance to OTP step
    await new Promise(r => setTimeout(r, 600));
    setSendingOtp(false);
    setStep(2);
    setDigits(['', '', '', '']);
    setTimeout(() => digitRefs.current[0]?.focus(), 100);
  }

  async function verifyOtp(otp: string) {
    setVerifying(true);
    setOtpError('');
    await new Promise(r => setTimeout(r, 500));
    if (otp === DEMO_OTP) {
      const returningName = localDB.getContact(mobile);
      localDB.saveContact(mobile, returningName ?? name);
      onVerified(returningName ?? name, mobile);
    } else {
      setOtpError('Invalid OTP. Use 1234 for demo.');
      setDigits(['', '', '', '']);
      digitRefs.current[0]?.focus();
    }
    setVerifying(false);
  }

  function handleDigitChange(index: number, val: string) {
    const char = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[index] = char;
    setDigits(next);

    if (char && index < 3) {
      digitRefs.current[index + 1]?.focus();
    }

    if (next.every(d => d !== '')) {
      verifyOtp(next.join(''));
    }
  }

  function handleDigitKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      digitRefs.current[index - 1]?.focus();
    }
  }

  async function handleResend() {
    if (!canResend) return;
    setSendingOtp(true);
    await new Promise(r => setTimeout(r, 600));
    setSendingOtp(false);
    setDigits(['', '', '', '']);
    setOtpError('');
    setCountdown(60);
    setCanResend(false);
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          setCanResend(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    setTimeout(() => digitRefs.current[0]?.focus(), 100);
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ backdropFilter: 'blur(4px)', backgroundColor: 'rgba(0,0,0,0.45)' }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-modal-in relative">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {step === 1 && (
          <>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-teal-50 flex items-center justify-center">
                <Phone className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-800">Verify your number</h2>
                <p className="text-xs text-gray-500">We'll send an OTP to confirm</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Your Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Full name"
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-700 outline-none focus:border-teal-400 focus:ring-2 focus:ring-teal-100 transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Mobile Number</label>
                <div className="flex items-center border border-gray-200 rounded-lg focus-within:border-teal-400 focus-within:ring-2 focus-within:ring-teal-100 transition-all overflow-hidden">
                  <span className="px-3 py-2.5 text-sm text-gray-500 bg-gray-50 border-r border-gray-200 select-none">+91</span>
                  <input
                    type="tel"
                    value={mobile}
                    onChange={e => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder="10-digit number"
                    maxLength={10}
                    className="flex-1 px-3 py-2.5 text-sm text-gray-700 outline-none bg-transparent"
                  />
                </div>
              </div>

              {sendError && (
                <p className="text-xs text-red-500">{sendError}</p>
              )}

              <button
                type="button"
                onClick={handleSendOtp}
                disabled={sendingOtp}
                className="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {sendingOtp ? 'Sending OTP...' : 'Send OTP'}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-teal-50 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-gray-800">Enter OTP</h2>
                <p className="text-xs text-gray-500">Sent to +91 {mobile}</p>
              </div>
            </div>

            <div className="flex gap-3 justify-center mb-4">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={el => { digitRefs.current[i] = el; }}
                  type="tel"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  onChange={e => handleDigitChange(i, e.target.value)}
                  onKeyDown={e => handleDigitKeyDown(i, e)}
                  disabled={verifying}
                  className="w-12 h-14 text-center text-xl font-bold rounded-xl border-2 border-gray-200 focus:border-teal-500 focus:ring-2 focus:ring-teal-100 outline-none transition-all text-gray-800 disabled:opacity-60"
                />
              ))}
            </div>

            {verifying && (
              <p className="text-center text-sm text-teal-600 mb-3">Verifying...</p>
            )}

            {otpError && (
              <p className="text-center text-xs text-red-500 mb-3">{otpError}</p>
            )}

            <div className="flex items-center justify-center gap-2 text-sm">
              {canResend ? (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={sendingOtp}
                  className="flex items-center gap-1 text-teal-600 font-semibold hover:underline disabled:opacity-60"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Resend OTP
                </button>
              ) : (
                <p className="text-gray-400 text-xs">
                  Resend in <span className="font-semibold text-gray-600">{countdown}s</span>
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setStep(1)}
              className="mt-4 w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Change number
            </button>
          </>
        )}
      </div>
    </div>
  );
}
