# Spike A: do two NixOS VMs run on this host, and can the client see every packet?
{ pkgs }:
pkgs.testers.runNixOSTest {
  name = "harness-vm-spike";
  # No QEMU user-mode NIC: on a macOS host it is a NAT to the internet (the
  # build has no network sandbox there). The driver uses a virtio console.
  defaults = { lib, ... }: {
    virtualisation.qemu.networkingOptions = lib.mkForce [ ];
  };
  # Node configs must use their own `pkgs` argument: the outer `pkgs` belongs
  # to the host, which is macOS here.
  nodes.server = { pkgs, ... }: {
    networking.firewall.allowedTCPPorts = [ 8000 ];
    systemd.services.web = {
      wantedBy = [ "multi-user.target" ];
      script = "mkdir -p /srv && echo hello > /srv/index.html && exec ${pkgs.python3}/bin/python3 -m http.server -d /srv 8000";
    };
  };
  nodes.client = { pkgs, ... }: {
    environment.systemPackages = [ pkgs.tcpdump pkgs.curl ];
  };
  testScript = ''
    start_all()
    server.wait_for_open_port(8000)
    client.wait_for_unit("multi-user.target")
    client.succeed("tcpdump -i any -w /tmp/cap.pcap -U >/dev/null 2>&1 & sleep 2")
    client.succeed("curl -sf http://server:8000/ | grep hello")
    print(client.succeed("ip -br link; ip route; ip -6 route"))
    client.fail("ip link show eth0")
    client.fail("curl -sf --max-time 5 http://1.1.1.1/")
    client.fail("curl -sf --max-time 5 http://[2606:4700:4700::1111]/")
    client.fail("curl -sf --max-time 5 https://example.com/")
    client.succeed("sleep 1; pkill -INT tcpdump; sleep 1")
    print(client.succeed("tcpdump -nn -r /tmp/cap.pcap 2>/dev/null | awk '{print $3, $4, $5}' | sort | uniq -c | sort -rn | head -20"))
  '';
}
