#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only).
# Most users put PATH additions for claude (npm/bun/brew global bins) in
# .zshrc, so source it explicitly here.
[[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
claude
echo
echo "[claude exited — dropping to zsh]"
exec zsh -i
