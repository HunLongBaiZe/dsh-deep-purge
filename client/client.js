// dsh-deep-purge — browser half.
//
// Bundle format (client-modules protocol): a CLASSIC script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports.
//
// Three registrations, all through official slots:
//   1. sidebar.workspaces.session.menu.item — the "彻底删除…" row (order 500);
//   2. shell.overlay — the confirmation gate, rendered with primitives'
//      RiskConfirmation (warning row + mandatory acknowledgement checkbox +
//      outline/primary button pair), the same component product surfaces use
//      for sensitive actions;
//   3. the same overlay entry also renders the post-delete summary through
//      Modal, with a primary action.
window.__ModuleLoader__.load({
  id: 'dsh-deep-purge',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect } = React
    const { jsx, jsxs } = require('react/jsx-runtime')

    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
      // Loud on purpose: without the primitives package every dialog falls back
      // to hand-styled markup. Log why, so this is never a mystery again.
      console.warn('[deep-purge] primitives unavailable, using styled fallback:', error && error.message ? error.message : error)
    }

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const LABEL = '彻底删除…'

    const CONFIRM_TEXT = [
      '将不可撤销地删除：会话日志文件（两种 id 拼写）、投影缓存条目、工作区记账（含归档列表引用），',
      '以及本会话引用到的附件副本。仍被其他会话引用的附件会自动保留；',
      '若任一其他会话的日志读不出来，附件回收会整体跳过。',
    ].join('')

    // --- tiny shared store: the menu row opens, the overlay renders ------------
    const state = { request: null }
    const listeners = new Set()
    function setRequest(next) {
      state.request = next
      for (const listener of [...listeners]) listener()
    }
    function useRequest() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((n) => n + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return state.request
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(2) + ' MB'
    }

    async function callPurge(sessionId) {
      const response = await fetch('/__deep-purge/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, confirm: sessionId, attachments: true, requestImages: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) throw new Error(data.error || ('HTTP ' + response.status))
      return data
    }

    function summaryLines(data) {
      const lines = []
      lines.push('日志目录：删除 ' + (Array.isArray(data.dirsRemoved) ? data.dirsRemoved.length : 0) + ' 个')
      lines.push('投影缓存：' + (data.projRemoved ? '已清' : '无需清理'))
      lines.push('工作区记账：' + (data.workspaceRemoved ? '已清' : '无需清理'))
      const a = data.attachments || {}
      if (a.skipped) {
        lines.push('附件回收：已跳过（' + (a.reason || '原因不明') + '）')
      } else {
        lines.push('附件回收：引用 ' + (a.referenced || 0) + ' 个 → 删除 ' + (a.deleted || 0) + ' 个（' + formatBytes(a.bytes) + '）')
        lines.push('因其他会话仍在引用而保留：' + (a.keptShared || 0) + ' 个（扫描了 ' + (a.scanned || 0) + ' 个会话）')
      }
      if (data.requestImages) {
        lines.push('请求图片缓存：清空 ' + (data.requestImages.files || 0) + ' 个（' + formatBytes(data.requestImages.bytes) + '）')
      }
      if (Array.isArray(data.remaining) && data.remaining.length > 0) {
        lines.push('注意：仍有 ' + data.remaining.length + ' 个残留目录')
      }
      return lines
    }

    const hasPrimitives = primitives !== null
    const Modal = hasPrimitives && typeof primitives.Modal === 'function' ? primitives.Modal : null
    const Button = hasPrimitives && typeof primitives.Button === 'function' ? primitives.Button : null
    const RiskConfirmation = hasPrimitives && typeof primitives.RiskConfirmation === 'function' ? primitives.RiskConfirmation : null

    /** Plain fallback used only when the primitives package is unavailable. */
    function SimpleDialog({ title, description, children, footer }) {
      return jsx('div', {
        role: 'dialog',
        'aria-label': title,
        style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
        children: jsxs('div', {
          style: { background: 'var(--dsw-alias-bg-primary, #1b1b1b)', padding: '20px', borderRadius: '12px', minWidth: '420px', maxWidth: '560px' },
          children: [
            jsx('div', { style: { fontWeight: 600, marginBottom: '8px' }, children: title }),
            description ? jsx('div', { style: { opacity: .8, marginBottom: '12px', lineHeight: 1.7 }, children: description }) : null,
            jsx('div', { children }),
            jsx('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }, children: footer }),
          ],
        }),
      })
    }
    // Capsule geometry and variant fills mirrored from the primitives'
    // Button.module.css, so the fallback still reads as a DSH button.
    const BTN_BASE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '4px',
      border: 'none',
      borderRadius: '18px',
      cursor: 'pointer',
      fontSize: '14px',
      lineHeight: '22px',
      height: '36px',
      padding: '0 14px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
    }
    const BTN_VARIANT = {
      primary: { background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))', color: 'var(--dsw-alias-label-primary-foreground)' },
      outline: { border: '0.5px solid var(--dsw-alias-border-l3)', background: 'transparent' },
      ghost: {},
    }
    function SimpleButton(props) {
      const { variant = 'ghost', size, icon, children, style, ...rest } = props
      const variantStyle = BTN_VARIANT[variant] || BTN_VARIANT.ghost
      const sizeStyle = size === 'sm' ? { height: '28px', fontSize: '12px', lineHeight: '18px', padding: '0 10px', borderRadius: '14px' } : {}
      return jsx('button', {
        type: 'button',
        ...rest,
        style: { ...BTN_BASE, ...variantStyle, ...sizeStyle, ...(style || {}) },
        children,
      })
    }

    // --- the menu row ---------------------------------------------------------
    function PurgeMenuItem({ sessionId, useMenuOpenState }) {
      const hook = typeof useMenuOpenState === 'function' ? useMenuOpenState : null
      const setMenuOpen = hook ? hook()[1] : () => {}
      const onSelect = () => {
        setMenuOpen(false)
        if (sessionId) setRequest({ sessionId })
      }
      if (hasPrimitives && typeof primitives.MenuItemButton === 'function') {
        return jsx(primitives.MenuItemButton, { danger: true, separatorBefore: true, onSelect, children: LABEL })
      }
      return jsx('button', { type: 'button', role: 'menuitem', onClick: onSelect, children: LABEL })
    }

    // --- confirmation gate + result ------------------------------------------
    function PurgeDialog() {
      const request = useRequest()
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)

      const requestId = request ? request.sessionId : null
      useEffect(() => {
        setAcknowledged(false)
        setBusy(false)
        setError(null)
        setResult(null)
      }, [requestId])

      const close = () => {
        if (busy) return
        setRequest(null)
      }
      const confirm = () => {
        if (!request) return
        setBusy(true)
        setError(null)
        callPurge(request.sessionId)
          .then((data) => { setResult(data) })
          .catch((reason) => { setError(reason && reason.message ? reason.message : String(reason)) })
          .then(() => { setBusy(false) })
      }

      if (!request) return null

      // 1) result
      if (result !== null) {
        const list = jsx('ul', {
          style: { margin: 0, paddingLeft: '18px', lineHeight: 1.9 },
          children: summaryLines(result).map((line, index) => jsx('li', { children: line }, index)),
        })
        if (Modal && Button) {
          return jsx(Modal, {
            open: true,
            onClose: () => window.location.reload(),
            closeLabel: '关闭',
            title: '已彻底删除',
            description: '会话数据已从磁盘清除。',
            footer: jsx(Button, { variant: 'primary', onClick: () => window.location.reload(), children: '完成并刷新' }),
            children: list,
          })
        }
        return jsx(SimpleDialog, {
          title: '已彻底删除',
          description: '会话数据已从磁盘清除。',
          footer: jsx(SimpleButton, { variant: 'primary', onClick: () => window.location.reload(), children: '完成并刷新' }),
          children: list,
        })
      }

      // 2) failure
      if (error !== null) {
        if (Modal && Button) {
          return jsx(Modal, {
            open: true,
            onClose: close,
            closeLabel: '关闭',
            title: '删除失败',
            description: error,
            footer: jsx(Button, { variant: 'primary', onClick: close, children: '关闭' }),
          })
        }
        return jsx(SimpleDialog, {
          title: '删除失败',
          description: error,
          footer: jsx(SimpleButton, { variant: 'primary', onClick: close, children: '关闭' }),
        })
      }

      // 3) the acknowledgement gate
      if (RiskConfirmation) {
        return jsx(RiskConfirmation, {
          open: true,
          title: '彻底删除这个会话？',
          description: CONFIRM_TEXT,
          acknowledgeLabel: '我明白此操作不可撤销',
          cancelLabel: '取消',
          closeLabel: '关闭',
          confirmLabel: busy ? '删除中…' : '彻底删除',
          acknowledged,
          disabled: busy,
          onAcknowledgedChange: setAcknowledged,
          onCancel: close,
          onConfirm: confirm,
        })
      }

      return jsx(SimpleDialog, {
        title: '彻底删除这个会话？',
        description: CONFIRM_TEXT,
        footer: jsxs(React.Fragment, {
          children: [
            jsx(SimpleButton, { variant: 'outline', disabled: busy, onClick: close, children: '取消' }),
            jsx(SimpleButton, { variant: 'primary', disabled: busy, onClick: confirm, children: busy ? '删除中…' : '彻底删除' }),
          ],
        }),
        children: jsx('label', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' },
          children: [
            jsx('input', { type: 'checkbox', checked: acknowledged, disabled: busy, onChange: (event) => setAcknowledged(event.target.checked) }),
            '我明白此操作不可撤销',
          ],
        }),
      })
    }

    const name = 'deep-purge'
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject(MENU_SLOT, function* () {
        yield ctx.slots.register({ name: MENU_SLOT, id: 'deep-purge.delete', order: 500 }, PurgeMenuItem)
      })
      ctx.slots.inject(OVERLAY_SLOT, function* () {
        yield ctx.slots.register({ name: OVERLAY_SLOT, id: 'deep-purge.dialog', label: () => 'deep-purge' }, PurgeDialog)
      })
    }

    return { name, inject, apply }
  },
})
