# fslock: system state notice at login (installed by pi-setup)
case $- in *i*) ;; *) return 0 2>/dev/null ;; esac
if [ "$(findmnt -no FSTYPE / 2>/dev/null)" = overlay ]; then
  printf '\033[1;32m[fslock] The system is LOCKED -- changes outside /data are lost at reboot. To update: wifilt-pi-setup\033[0m\n'
else
  printf '\033[1;33m[fslock] The system is UNLOCKED -- when done with changes: sudo fslock lock\033[0m\n'
fi
mountpoint -q /data 2>/dev/null || printf '\033[1;31m[fslock] The data card /data is not mounted!\033[0m\n'
if [ -r /run/wifilt-pi/relock-at ]; then
  _fsl_left=$(( ( $(cat /run/wifilt-pi/relock-at) - $(date +%s) + 59 ) / 60 ))
  [ "$_fsl_left" -gt 0 ] 2>/dev/null && printf '\033[1;33m[fslock] Update finished; the system locks itself in %s min. Cancel: wifilt-pi-setup --keep-unlocked\033[0m\n' "$_fsl_left"
  unset _fsl_left
fi
[ -r /var/lib/wifilt-pi/resume-failed ] && printf '\033[1;31m[pi-setup] The last update failed: %s\033[0m\n' "$(cat /var/lib/wifilt-pi/resume-failed)"
