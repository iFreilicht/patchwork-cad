# Spike B: does the Patchwork site boot in all three browsers inside a VM, and
# does a capture on the client show every egress attempt with its payload?
# `dist` is the built site (src/harness/site/dist), passed in impurely.
{ pkgs, dist }:
pkgs.testers.runNixOSTest {
  name = "harness-vm-spike-browsers";
  defaults =
    { lib, ... }:
    {
      # No QEMU user-mode NIC: on a macOS host it is a NAT to the internet.
      virtualisation.qemu.networkingOptions = lib.mkForce [ ];
    };

  # Answers every DNS name with its own address and accepts every TCP port,
  # so that exfiltration attempts actually send their payload.
  nodes.attacker =
    { pkgs, nodes, ... }:
    {
      networking.firewall.enable = false;
      environment.systemPackages = [ pkgs.binutils ];
      services.dnsmasq = {
        enable = true;
        resolveLocalQueries = false;
        settings = {
          address = "/#/${nodes.attacker.networking.primaryIPAddress}";
          no-resolv = true;
        };
      };
      # Stands in for the internet: the client's default gateway, so packets to
      # any address arrive here, and every TCP connection reaches the catch-all.
      boot.kernel.sysctl."net.ipv4.ip_forward" = 0;
      networking.nftables = {
        enable = true;
        tables.catchall = {
          family = "inet";
          content = ''
            chain prerouting {
              type nat hook prerouting priority dstnat;
              iifname "eth1" tcp dport != 53 redirect to :9999
            }
          '';
        };
      };
      systemd.services.catchall = {
        wantedBy = [ "multi-user.target" ];
        script = "exec ${pkgs.python3}/bin/python3 ${./catchall.py} 9999 /tmp/catchall.log";
      };
    };

  nodes.client =
    { pkgs, nodes, ... }:
    {
      virtualisation.memorySize = 4096;
      # Reading the browsers from the host's store over 9p is very slow on macOS.
      virtualisation.useNixStoreImage = true;
      virtualisation.cores = 4;
      networking.nameservers = [ nodes.attacker.networking.primaryIPAddress ];
      networking.defaultGateway = nodes.attacker.networking.primaryIPAddress;
      networking.defaultGateway6 = nodes.attacker.networking.primaryIPv6Address;
      environment.systemPackages = [
        pkgs.tcpdump
        pkgs.binutils
        pkgs.nodejs_24
      ];
      fonts.enableDefaultPackages = true;
      # Mesa (llvmpipe) for WPE WebKit's EGL; Chromium and Firefox bring their own.
      hardware.graphics.enable = true;
      users.users.tester = {
        isNormalUser = true;
      };
      systemd.services.site = {
        wantedBy = [ "multi-user.target" ];
        script = "exec ${pkgs.python3}/bin/python3 -m http.server --bind 127.0.0.1 -d ${dist} 8080";
      };
    };

  testScript = ''
    start_all()
    attacker.wait_for_unit("dnsmasq.service")
    attacker.wait_for_unit("catchall.service")
    client.wait_for_open_port(8080)
    client.succeed("tcpdump -i any -s 0 -w /tmp/cap.pcap -U >/dev/null 2>&1 & sleep 2")

    import time
    for browser in ["chromium", "firefox", "webkit"]:
      client.succeed(
        "(timeout 240 runuser -u tester -- env DEBUG=pw:api PLAYWRIGHT_BROWSERS_PATH=${pkgs.pkgsLinux.playwright-driver.browsers} "
        f"node ${./spike-probe.ts} ${pkgs.pkgsLinux.playwright-driver} http://localhost:8080/ {browser} "
        f"> /tmp/probe-{browser}.log 2>&1; echo EXIT=$? >> /tmp/probe-{browser}.log) >/dev/null 2>&1 &"
      )
      for _ in range(20):
        time.sleep(15)
        if "EXIT=" in client.succeed(f"cat /tmp/probe-{browser}.log"):
          break
      print(client.succeed(f"grep -vE 'pw:browser' /tmp/probe-{browser}.log | cut -c1-200"))
      client.copy_from_vm(f"/tmp/probe-{browser}.log")
      print(client.succeed("ps -u tester -o pid,ppid,etime,pcpu,rss,comm --sort=start_time || true"))

    client.succeed("sleep 2; pkill -INT tcpdump; sleep 2")
    print(client.succeed("tcpdump -nn -r /tmp/cap.pcap 'not host 127.0.0.1 and not ip6 host ::1' 2>/dev/null | awk '{print $3, $4, $5, $6}' | sed -E 's/\\.[0-9]+ / /' | sort | uniq -c | sort -rn | head -40"))
    client.copy_from_vm("/tmp/cap.pcap")
    attacker.copy_from_vm("/tmp/catchall.log")
    # Exact byte search for each known canary: regex extraction from `strings`
    # picks up adjacent printable bytes of the pcap framing.
    def seen_in(machine, path, canary):
      return machine.execute(f"grep -aqF {canary} {path}")[0] == 0
    missing = []
    for browser in ["chromium", "firefox", "webkit"]:
      for kind in ["fetch-host", "fetch-query", "image", "beacon-body", "websocket", "webrtc-stun", "ip-literal"]:
        c = f"canary-{browser}-{kind}"
        capture = seen_in(client, "/tmp/cap.pcap", c)
        if not capture:
          missing.append(c)
        caught = seen_in(attacker, "/tmp/catchall.log", c)
        print(f"{c:40} capture={'yes' if capture else 'NO '} attacker={'yes' if caught else 'no'}")
    assert not missing, f"canaries missing from the capture: {missing}"
  '';
}
