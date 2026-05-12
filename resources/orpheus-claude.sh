#!/bin/zsh -l
# Login zsh: sources .zshenv, .zprofile, .zshrc. Full env.
claude
echo
echo "[claude exited — dropping to zsh]"
exec zsh -i
