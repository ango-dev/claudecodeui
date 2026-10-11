import { useEffect, useState } from 'react';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < mobileBreakpoint;
};

/** Phones are under this on their short side; the smallest iPad is 744pt. */
const PHONE_SCREEN_MAX_SHORT_SIDE = 600;

/**
 * True on a phone-sized screen, where the sidebar can only be a slide-over.
 *
 * Read from the physical screen rather than the window width: the window can
 * report a narrow width for a moment on an iPad (launch from the home screen,
 * Split View, Stage Manager), which used to force the slide-over sidebar on a
 * device where it is only a preference. The screen does not change, so this
 * needs no listener.
 */
export const isPhoneSizedScreen = (): boolean => {
  if (typeof window === 'undefined' || !window.screen) {
    return false;
  }
  const shortSide = Math.min(window.screen.width, window.screen.height);
  // Zero means the size is unknown (no real screen), not a tiny one.
  return shortSide > 0 && shortSide < PHONE_SCREEN_MAX_SHORT_SIDE;
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    trackMobile = true,
    trackPWA = true
  } = options;

  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    const checkMobile = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, [mobileBreakpoint, trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  return { isMobile, isPWA };
}
