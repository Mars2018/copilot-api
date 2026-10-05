import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

import AuthPage from '../src/pages/AuthPage'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type { AuthResult } from '../src/types/ipc'

const authUrl =
  'https://auth.openai.com/oauth/authorize?state=test&code_challenge=test'
let win: Window
let root: Root
let container: HTMLDivElement
let pending: ReturnType<typeof Promise.withResolvers<AuthResult>>
let onUrl: ((url: string) => void) | undefined
let onSaving: (() => void) | undefined
const unsubscribe = mock(() => {})
const unsubscribeSaving = mock(() => {})
const openUrl = mock(() => Promise.resolve())
const copyUrl = mock(() => Promise.resolve())
const onSuccess = mock((_result: AuthResult) => {})
const cancel = mock(() => {
  pending.resolve({ success: false, cancelled: true })
  return Promise.resolve(true)
})
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  pending = Promise.withResolvers<AuthResult>()
  onUrl = undefined
  onSaving = undefined
  for (const fn of [
    unsubscribe,
    unsubscribeSaving,
    openUrl,
    copyUrl,
    onSuccess,
    cancel,
  ])
    fn.mockClear()
  Object.defineProperty(win.navigator.clipboard, 'writeText', {
    value: copyUrl,
    configurable: true,
  })
  Object.defineProperty(win, 'electronAPI', {
    value: {
      getCodexAccounts: () => Promise.resolve([]),
      startCodexLogin: () => {
        onUrl?.(authUrl)
        return pending.promise
      },
      onCodexAuthUrl: (callback: (url: string) => void) => {
        onUrl = callback
        return unsubscribe
      },
      onCodexLoginSaving: (callback: () => void) => {
        onSaving = callback
        return unsubscribeSaving
      },
      cancelCodexLogin: cancel,
      openUrl,
      windowIsMaximized: () => Promise.resolve(false),
      onWindowMaximizeChange: () => () => {},
      getAppUpdateStatus: () => Promise.resolve({ phase: 'disabled' }),
      onAppUpdateStatus: () => () => {},
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}

async function start(back?: () => void) {
  await act(async () => {
    root.render(
      createElement(LanguageProvider, {
        children: createElement(AuthPage, { onSuccess, onBack: back }),
      }),
    )
  })
  await act(async () => button('Sign in with OpenAI Codex').click())
  await act(async () => button('Add or sign in again').click())
}

describe('Codex authorization page', () => {
  test('shows a copyable URL and opens the browser only after a manual click', async () => {
    await start()
    const field = container.querySelector('textarea')!
    expect(field.value).toBe(authUrl)
    expect(field.readOnly).toBe(true)
    expect(container.textContent).toContain('within 2 minutes')
    expect(openUrl).not.toHaveBeenCalled()
    await act(async () => button('Open authorization page').click())
    expect(openUrl).toHaveBeenCalledWith(authUrl)
    await act(async () => button('Copy').click())
    expect(copyUrl).toHaveBeenCalledWith(authUrl)
    expect(container.textContent).toContain('✓ Copied')
    await act(async () => {
      field.focus()
    })
    expect(field.selectionEnd).toBe(authUrl.length)
  })

  test('cancels and returns to the account list without showing an error', async () => {
    await start()
    await act(async () => button('Cancel authorization').click())
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalled()
    expect(container.textContent).toContain('Add or sign in again')
    expect(container.textContent).not.toContain('Authorization failed')
    expect(container.querySelector('textarea')).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    pending = Promise.withResolvers<AuthResult>()
    await act(async () => button('Add or sign in again').click())
    expect(container.querySelector('textarea')?.value).toBe(authUrl)
  })

  test('ignores late results and URL events after leaving the waiting page', async () => {
    await start()
    const lateUrl = onUrl!
    await act(async () => button('← Back').click())
    expect(cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      lateUrl('https://auth.example/stale')
      pending.resolve({ success: true, mode: 'provider' })
    })
    expect(onSuccess).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Sign in with OpenAI Codex')
    expect(container.querySelector('textarea')).toBeNull()
  })

  test('cancels and unsubscribes when the page unmounts', async () => {
    await start()
    await act(async () => root.unmount())
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('completes a successful sign-in', async () => {
    await start()
    const result: AuthResult = {
      success: true,
      mode: 'provider',
      providers: ['codex'],
    }
    await act(async () => pending.resolve(result))
    expect(onSuccess).toHaveBeenCalledWith(result)
    expect(unsubscribe).toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  test('disables cancellation while finishing sign-in and preserves refresh failures', async () => {
    await start()
    await act(async () => onSaving?.())
    expect(container.textContent).toContain('Finishing sign-in')
    expect(button('Cancel authorization').disabled).toBe(true)
    expect(container.querySelector('textarea')).toBeNull()
    expect(cancel).not.toHaveBeenCalled()
    await act(async () =>
      pending.resolve({
        success: false,
        error: 'Configuration saved, but refresh failed: connection failed',
      }),
    )
    expect(container.textContent).toContain(
      'Configuration saved, but refresh failed',
    )
    expect(button('Add or sign in again').disabled).toBe(false)
    expect(unsubscribeSaving).toHaveBeenCalled()
  })

  test('leaves cancelling state when persistence has already begun in the main process', async () => {
    cancel.mockImplementationOnce(() => Promise.resolve(false))
    await start()
    await act(async () => button('Cancel authorization').click())
    expect(container.textContent).toContain('Finishing sign-in')
    expect(container.textContent).not.toContain('Cancelling…')
    expect(button('Cancel authorization').disabled).toBe(true)
    await act(async () => pending.resolve({ success: true, mode: 'provider' }))
    expect(onSuccess).toHaveBeenCalled()
  })

  test('returns immediately when cancelling a queued login and ignores its later result', async () => {
    cancel.mockImplementationOnce(() => Promise.resolve(true))
    await start()
    await act(async () => button('Cancel authorization').click())
    expect(button('Add or sign in again').disabled).toBe(false)
    expect(container.textContent).not.toContain('Cancelling…')
    expect(unsubscribeSaving).toHaveBeenCalled()
    await act(async () => pending.resolve({ success: false, cancelled: true }))
    expect(button('Add or sign in again').disabled).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
  })

  test('returns to the account list after adding an account from the dashboard', async () => {
    await start(() => {})
    await act(async () => pending.resolve({ success: true, mode: 'provider' }))
    expect(onSuccess).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Add or sign in again')
    expect(container.querySelector('textarea')).toBeNull()
  })

  test.each([
    { success: false, error: 'Missing Codex authorization code' },
    { success: false },
  ])(
    'reports an authorization failure and enables retry: %j',
    async (result) => {
      await start()
      await act(async () => pending.resolve(result))
      expect(container.textContent).toContain(
        result.error ?? 'Authorization failed',
      )
      expect(button('Add or sign in again').disabled).toBe(false)
      expect(unsubscribe).toHaveBeenCalled()
    },
  )

  test('reports a rejected login request and enables retry', async () => {
    await start()
    await act(async () => pending.reject(new Error('IPC failed')))
    expect(container.textContent).toContain('IPC failed')
    expect(button('Add or sign in again').disabled).toBe(false)
  })

  test('keeps cancellation available after a browser launch failure', async () => {
    openUrl.mockRejectedValueOnce(new Error('Browser failed'))
    await start()
    await act(async () => button('Open authorization page').click())
    expect(container.textContent).toContain('Browser failed')
    expect(button('Cancel authorization').disabled).toBe(false)
  })

  test('reports clipboard failures', async () => {
    copyUrl.mockRejectedValueOnce(new Error('Clipboard failed'))
    await start()
    await act(async () => button('Copy').click())
    expect(container.textContent).toContain('Clipboard failed')
  })

  test('allows cancellation to be retried after an IPC failure', async () => {
    cancel.mockRejectedValueOnce(new Error('Cancel failed'))
    await start()
    await act(async () => button('Cancel authorization').click())
    expect(container.textContent).toContain('Cancel failed')
    expect(button('Cancel authorization').disabled).toBe(false)
    await act(async () => button('Cancel authorization').click())
    expect(container.textContent).toContain('Add or sign in again')
  })
})
