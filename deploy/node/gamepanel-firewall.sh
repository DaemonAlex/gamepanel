#!/bin/sh
# Node firewall for game containers. Safe to run any number of times.
#
# Docker only supports iptables rules (nftables underneath, via iptables-nft),
# placed in its DOCKER-USER chain. Raw nft rules are not supported with Docker.
#
# 1. Containers may reach the internet, but no private range: not the node's
#    network, not hv, not the tailnet, not other guests.
# 2. Containers may not open connections to the node itself (agent, ssh).
# 3. Same for the per-server database links.
set -eu

SUBNET="${GAMEPANEL_SUBNET:-172.30.0.0/24}"
BRIDGE="${GAMEPANEL_BRIDGE:-gp-br0}"

iptables -w -N GAMEPANEL-FWD 2>/dev/null || iptables -w -F GAMEPANEL-FWD
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -w -A GAMEPANEL-FWD -s "$SUBNET" -d "$net" -j DROP
done
iptables -w -A GAMEPANEL-FWD -j RETURN
iptables -w -N DOCKER-USER 2>/dev/null || true
iptables -w -C DOCKER-USER -j GAMEPANEL-FWD 2>/dev/null || iptables -w -I DOCKER-USER 1 -j GAMEPANEL-FWD

iptables -w -N GAMEPANEL-IN 2>/dev/null || iptables -w -F GAMEPANEL-IN
iptables -w -A GAMEPANEL-IN -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A GAMEPANEL-IN -i "$BRIDGE" -j DROP
# 3. The private database links (one bridge per server, gpdb<hash>) carry only
#    server <-> database traffic; nothing on them may reach the node itself.
iptables -w -A GAMEPANEL-IN -i gpdb+ -j DROP
iptables -w -A GAMEPANEL-IN -j RETURN
iptables -w -C INPUT -j GAMEPANEL-IN 2>/dev/null || iptables -w -I INPUT 1 -j GAMEPANEL-IN
