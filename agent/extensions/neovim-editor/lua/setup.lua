local channel, lines, row, byte_col = ...

-- Pi renders the active mode in its editor border. Keep Neovim's native
-- command line and messages, but omit its redundant statusline and mode row.
vim.o.laststatus = 0
vim.o.showmode = false
vim.o.ruler = false
vim.o.cmdheight = 0

local buffer = vim.api.nvim_create_buf(false, true)
vim.g.pi_prompt_buffer = buffer
vim.api.nvim_buf_set_name(buffer, "[Pi Prompt]")
vim.bo[buffer].bufhidden = "hide"
vim.bo[buffer].swapfile = false
vim.bo[buffer].undofile = false
vim.bo[buffer].filetype = "markdown"
vim.api.nvim_set_current_buf(buffer)
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
vim.api.nvim_win_set_cursor(0, { row + 1, byte_col })
vim.api.nvim_buf_create_user_command(buffer, "PiSubmit", function()
  vim.rpcnotify(channel, "pi_submit")
end, { desc = "Submit the current prompt to Pi" })

-- Pi grows the external UI to the prompt's rendered height. Neovim's view
-- clamping leaves '~' filler rows below the last line whenever the window is
-- taller than the content between the view's top line and the buffer end,
-- which wastes prompt rows. The viewport is therefore normalized so the last
-- line's final screen row sits exactly on the window's bottom row, letting the
-- view top start mid-line ('smoothscroll' keeps that state across redraws).
-- Reassert scrolloff because user configuration may set it for every window or
-- markdown buffer.
vim.wo.smoothscroll = true

local normalizing_viewport = false
local function rows_to_end(from_line, last_line)
  if from_line > last_line then
    return 0
  end
  return vim.api.nvim_win_text_height(0, { start_row = from_line - 1, end_row = last_line - 1 }).all
end

local function normalize_viewport()
  local window = vim.fn.bufwinid(buffer)
  if window == -1 or not vim.api.nvim_win_is_valid(window) then
    return
  end

  vim.wo[window].scrolloff = 0
  if normalizing_viewport then
    return
  end

  normalizing_viewport = true
  pcall(vim.api.nvim_win_call, window, function()
    local last_line = vim.fn.line("$")
    local height = vim.api.nvim_win_get_height(0)
    -- Where does the last line's final screen row sit right now?
    local eof_row = vim.fn.screenpos(0, last_line, vim.fn.col({ last_line, "$" })).row
    if eof_row == 0 or eof_row >= height then
      -- Either the buffer end is below the fold (the window is full of
      -- content) or it already sits on the bottom row.
      return
    end
    -- The whole buffer must be tall enough to fill the window, otherwise the
    -- dead rows cannot be filled from above.
    if rows_to_end(1, last_line) < height then
      return
    end
    -- Find the largest topline whose row span to the buffer end reaches the
    -- window height; the remainder becomes the mid-line offset of the view
    -- top. The search stays within [1, topline], so the cursor line never
    -- ends up above the view top.
    local view = vim.fn.winsaveview()
    local lo, hi = 1, view.topline
    while lo < hi do
      local mid = math.floor((lo + hi + 1) / 2)
      if rows_to_end(mid, last_line) >= height then
        lo = mid
      else
        hi = mid - 1
      end
    end
    local topfill = rows_to_end(lo, last_line) - height
    view.topline = lo
    view.topfill = topfill
    -- The mid-line offset may also be represented as a column skip of the
    -- topline ('smoothscroll'); clear it so the offset above is the only
    -- source of truth.
    view.skipcol = 0
    vim.fn.winrestview(view)
  end)
  normalizing_viewport = false
end
_G.pi_normalize_prompt_viewport = normalize_viewport
normalize_viewport()

local group = vim.api.nvim_create_augroup("PiEmbeddedPrompt", { clear = true })
vim.api.nvim_create_autocmd(
  { "TextChanged", "TextChangedI", "CursorMoved", "CursorMovedI", "ModeChanged", "BufEnter" },
  {
    group = group,
    callback = function()
      vim.rpcnotify(channel, "pi_state_dirty")
    end,
  }
)
vim.api.nvim_create_autocmd("WinScrolled", {
  group = group,
  callback = function()
    normalize_viewport()
    vim.rpcnotify(channel, "pi_state_dirty")
  end,
})
vim.api.nvim_create_autocmd("VimLeavePre", {
  group = group,
  once = true,
  callback = function()
    vim.rpcnotify(channel, "pi_exit")
  end,
})

vim.cmd.startinsert()
return buffer
